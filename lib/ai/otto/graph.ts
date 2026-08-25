import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

import { completedMilestones, isMilestoneComplete } from "../../onboarding/completion.ts";
import {
  MILESTONE_IDS,
  availableMilestones,
  sanitizePlan,
  type MilestoneId,
} from "../../onboarding/milestones.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getClaraCheckpointer } from "../agent/checkpointer.ts";
import { createToolLoopNodes } from "../agent/tool-loop.ts";
import { getChatModel } from "../agent/model.ts";
import type { OttoRunContext } from "./context.ts";
import {
  buildOttoSystemPrompt,
  buildPlannerPrompt,
  buildProfileQuestionPrompt,
} from "./prompt.ts";
import { OttoState, PROFILE_QUESTIONS, type OttoStateType } from "./state.ts";
import { buildOttoTools } from "./tools.ts";

const log = logger.child("ai.otto");

/**
 * Otto's onboarding graph.
 *
 *   entry ─▶ profile ─▶ plan ─▶ guide ─▶ verify ─▶ END
 *
 * Each user message runs one pass. State survives between passes through the
 * shared Mongo checkpointer, which is what makes a mid-tour refresh resume
 * rather than restart.
 *
 * TWO DELIBERATE DEPARTURES from the sketch in the brief:
 *
 * 1. `profile` does not use LangGraph's `interrupt()`. It asks one question,
 *    ends the turn, and reads the answer from the next user message. The UI
 *    still renders real buttons — it gets the choices from a `state` event and
 *    sends the chosen id as the message. Going through `interrupt()` would
 *    mean resuming with `Command({resume})` instead of a message, which the
 *    shared SSE turn runner has no way to express; this keeps one code path
 *    for every agent instead of forking it for Otto.
 *
 * 2. There is no separate `answer` node. Routing between "guide" and "answer"
 *    would need an extra classification round trip whose only failure mode is
 *    misrouting, and both branches end the same way — the user gets a real
 *    reply and the tour continues. The guide prompt handles off-script
 *    questions directly instead.
 */

const PlanSchema = z.object({
  milestoneIds: z
    .array(z.enum(MILESTONE_IDS))
    .min(1)
    .max(MILESTONE_IDS.length)
    .describe("The chosen milestone ids, in the order the user should do them."),
});

/** Last human turn, which is how an answer to a profile question arrives. */
function lastUserText(state: OttoStateType): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message.getType() === "human") {
      return typeof message.content === "string" ? message.content.trim() : "";
    }
  }
  return "";
}

export async function buildOttoGraph(ctx: OttoRunContext) {
  const env = aiEnv();
  const model = await getChatModel({ role: "otto" });
  const tools = buildOttoTools(ctx);

  const candidates = availableMilestones({
    role: ctx.onboardingRole,
    matchEnabled: ctx.matchEnabled,
  });

  /**
   * Ask the profile questions one at a time, recording each answer as it
   * arrives. `pendingQuestion` is what makes this resumable: it says which
   * question the next user message is answering.
   */
  const profileNode = async (state: OttoStateType, config: RunnableConfig) => {
    const profile = { ...state.userProfile };

    if (state.pendingQuestion) {
      const answer = lastUserText(state);
      // The UI sends a choice id; a user typing prose instead still counts as
      // an answer, because pinning them to the buttons would be worse than a
      // slightly noisy profile value.
      if (answer) profile[state.pendingQuestion] = answer.slice(0, 120);
    }

    const next = PROFILE_QUESTIONS.find((question) => !profile[question]);
    if (!next) {
      return {
        userProfile: profile,
        pendingQuestion: null,
        status: "planning" as const,
      };
    }

    // The model ASKS the question, rather than the node silently setting
    // `pendingQuestion` and ending the turn. Without this the turn produces no
    // assistant text at all and the user is left staring at an empty bubble —
    // the buttons alone are not an answer to "say something".
    const question = await model.invoke(
      [
        new SystemMessage(buildProfileQuestionPrompt(ctx, next, profile)),
        ...state.messages.slice(-4),
      ],
      config,
    );

    return {
      messages: [question],
      userProfile: profile,
      pendingQuestion: next,
      status: "profiling" as const,
    };
  };

  /**
   * Choose the milestones. The model picks ids from a zod enum built out of
   * the registry, so it cannot name one that does not exist; `sanitizePlan`
   * then enforces role, feature availability and prerequisite order in code.
   */
  const planNode = async (state: OttoStateType, config: RunnableConfig) => {
    const alreadyDone = await completedMilestones(ctx.milestoneContext);
    const open = candidates.filter((milestone) => !alreadyDone.includes(milestone.id));

    if (open.length === 0) {
      return {
        plannedMilestones: [],
        currentMilestoneId: null,
        completedMilestoneIds: alreadyDone,
        status: "completed" as const,
      };
    }

    let proposed: string[] = [];
    try {
      const planner = model.withStructuredOutput(PlanSchema, { name: "onboarding_plan" });
      const result = await planner.invoke(
        [
          new SystemMessage(
            buildPlannerPrompt({
              role: ctx.onboardingRole,
              profile: state.userProfile,
              candidates: open.map((milestone) => ({
                id: milestone.id,
                description: milestone.modelDescription,
                requires: milestone.requires ?? [],
              })),
              alreadyComplete: alreadyDone,
            }),
          ),
        ],
        config,
      );
      proposed = result.milestoneIds;
    } catch (error) {
      // A planner failure must not leave someone with no onboarding at all.
      log.warn("planner failed, falling back to registry order", {
        error: String(error),
      });
      proposed = open.map((milestone) => milestone.id);
    }

    const planned = sanitizePlan({
      proposed,
      role: ctx.onboardingRole,
      matchEnabled: ctx.matchEnabled,
    }).filter((id) => !alreadyDone.includes(id));

    const dropped = proposed.filter((id) => !(planned as string[]).includes(id));
    if (dropped.length > 0) {
      // The drift signal: the model asked for something the registry refused.
      log.info("dropped milestones from plan", { dropped, userId: ctx.userId });
    }

    const fallback = planned.length > 0 ? planned : open.map((m) => m.id).slice(0, 3);

    return {
      plannedMilestones: fallback,
      currentMilestoneId: fallback[0] ?? null,
      completedMilestoneIds: alreadyDone,
      attemptCount: 0,
      status: fallback.length > 0 ? ("guiding" as const) : ("completed" as const),
    };
  };

  /**
   * The guide turn IS the shared capped tool loop — nodes and all.
   *
   * An earlier version reimplemented the model call here to get a per-turn
   * prompt, and in doing so dropped `windowFromUserTurn` / `sanitizeToolPairs`
   * and the media resolution that go with it. Gemini answered the resulting
   * malformed history with empty content, so every reply came back blank. The
   * prompt is a function of state now, which is the supported way to vary it.
   */
  const loop = createToolLoopNodes({
    model,
    tools,
    systemPrompt: (state) =>
      new SystemMessage(buildOttoSystemPrompt(ctx, state as OttoStateType)),
    maxIterations: env.agentMaxIterations,
    historyMaxMessages: env.agentHistoryMaxMessages,
    historyMaxTokens: env.agentHistoryMaxTokens,
  });

  /**
   * Advance only on real data. The model's claim that a step is finished is
   * not evidence, so this never reads the conversation — only the database.
   */
  const verifyNode = async (state: OttoStateType) => {
    const current = state.currentMilestoneId;
    if (!current) return { status: "completed" as const, justAdvanced: false };

    // Second pass this turn, straight after auto-advancing into this
    // milestone. The user has not had a chance to do it yet, so checking now
    // would only manufacture a failed attempt.
    if (state.justAdvanced) return { justAdvanced: false };

    const done = await isMilestoneComplete(current, ctx.milestoneContext);
    if (!done) {
      const attemptCount = state.attemptCount + 1;
      log.info("milestone not yet complete", {
        milestoneId: current,
        attemptCount,
        userId: ctx.userId,
      });
      return { attemptCount };
    }

    const completed = state.completedMilestoneIds.includes(current)
      ? state.completedMilestoneIds
      : [...state.completedMilestoneIds, current];
    const remaining = state.plannedMilestones.filter(
      (id: MilestoneId) => !completed.includes(id),
    );

    log.info("milestone completed", { milestoneId: current, userId: ctx.userId });

    const hasNext = remaining.length > 0;
    return {
      completedMilestoneIds: completed,
      currentMilestoneId: remaining[0] ?? null,
      attemptCount: 0,
      status: hasNext ? ("guiding" as const) : ("completed" as const),
      // Roll straight on to the next step in this same turn.
      justAdvanced: hasNext,
      autoAdvances: state.autoAdvances + (hasNext ? 1 : 0),
    };
  };

  const graph = new StateGraph(OttoState)
    // `beginTurn` re-arms the tool-loop cap. Omitting it let `iterations`
    // accumulate across turns until it passed the cap for good, after which
    // every turn short-circuited to finalize and Otto could never call a tool
    // — so it could never navigate or spotlight anything again.
    // Wraps the shared beginTurn so the per-turn auto-advance budget resets
    // alongside the iteration cap.
    .addNode("beginTurn", () => ({ iterations: 0, autoAdvances: 0, justAdvanced: false }))
    .addNode("profile", profileNode)
    .addNode("plan", planNode)
    .addNode("guide", loop.model)
    .addNode("tools", loop.tools)
    .addNode("finalize", loop.finalize)
    .addNode("verify", verifyNode)
    .addEdge(START, "beginTurn")
    .addConditionalEdges(
      "beginTurn",
      (state: OttoStateType) => {
        if (state.status === "profiling") return "profile";
        if (state.status === "planning") return "plan";
        return "guide";
      },
      { profile: "profile", plan: "plan", guide: "guide" },
    )
    // A turn that asked a question ends there; the answer is the next message.
    .addConditionalEdges(
      "profile",
      (state: OttoStateType) => (state.pendingQuestion ? "wait" : "plan"),
      { wait: END, plan: "plan" },
    )
    // Planning immediately hands over to the guide so the same turn that
    // produces a plan also introduces its first step.
    .addEdge("plan", "guide")
    .addConditionalEdges(
      "guide",
      (state: OttoStateType) => loop.routeAfterModel(state),
      { tools: "tools", finalize: "finalize", done: "verify" },
    )
    .addEdge("tools", "guide")
    // Finalize re-asks with no tools bound, so the cap can never end a turn
    // in silence; verification then runs on whatever it said.
    .addEdge("finalize", "verify")
    // Completing a step rolls straight into introducing the next one, so the
    // user never has to type "next" to keep the tour moving. Capped at one
    // hop per turn: two milestones' worth of instructions at once is a wall
    // of text, not momentum.
    .addConditionalEdges(
      "verify",
      (state: OttoStateType) =>
        state.justAdvanced && state.autoAdvances <= 1 ? "guide" : "end",
      { guide: "guide", end: END },
    );

  return graph.compile({ checkpointer: await getClaraCheckpointer() });
}
