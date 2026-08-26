"use client";

import type { BlockKind, BlockPayload, BlockState } from "@/lib/ai/iris/blocks";

import { BlockNotice, BlockSkeleton } from "./block-shell";
import {
  BidVerdictBlock,
  DeadlineTimelineBlock,
  RequirementChecklistBlock,
} from "./blocks/analysis-blocks";
import { DocumentShelfBlock, EvidencePanelBlock } from "./blocks/document-blocks";
import { ChoicePromptBlock, FilterRefineBlock } from "./blocks/interactive-blocks";
import {
  CompanySnapshotBlock,
  CpvExplorerBlock,
  MetricSummaryBlock,
  PipelineBoardBlock,
} from "./blocks/overview-blocks";
import {
  TenderCompareBlock,
  TenderGridBlock,
  TenderSpotlightBlock,
} from "./blocks/tender-blocks";

/**
 * Kind → component. The client half of the catalog in `lib/ai/iris/blocks.ts`.
 *
 * The switch is exhaustive on `BlockKind` and TypeScript enforces it: adding a
 * schema to the catalog without adding a component here is a compile error,
 * not a blank space in production. That is the whole reason the catalog is a
 * const object rather than a list of strings.
 *
 * The three-state envelope is handled once, here, so no block component has to
 * know it is being streamed:
 *
 *   loading → a skeleton shaped like the block that is coming
 *   ready   → the component
 *   error   → a neutral notice card (usually "nothing generated yet")
 */

/** Narrowed per kind so each component keeps its own payload type. */
function ReadyBlock({
  kind,
  block,
  blockId,
}: {
  kind: BlockKind;
  block: unknown;
  blockId: string;
}) {
  switch (kind) {
    case "metric-summary":
      return (
        <MetricSummaryBlock block={block as BlockPayload<"metric-summary">} blockId={blockId} />
      );
    case "tender-grid":
      return <TenderGridBlock block={block as BlockPayload<"tender-grid">} blockId={blockId} />;
    case "tender-spotlight":
      return (
        <TenderSpotlightBlock
          block={block as BlockPayload<"tender-spotlight">}
          blockId={blockId}
        />
      );
    case "tender-compare":
      return (
        <TenderCompareBlock block={block as BlockPayload<"tender-compare">} blockId={blockId} />
      );
    case "bid-verdict":
      return <BidVerdictBlock block={block as BlockPayload<"bid-verdict">} blockId={blockId} />;
    case "requirement-checklist":
      return (
        <RequirementChecklistBlock
          block={block as BlockPayload<"requirement-checklist">}
          blockId={blockId}
        />
      );
    case "deadline-timeline":
      return (
        <DeadlineTimelineBlock
          block={block as BlockPayload<"deadline-timeline">}
          blockId={blockId}
        />
      );
    case "document-shelf":
      return (
        <DocumentShelfBlock block={block as BlockPayload<"document-shelf">} blockId={blockId} />
      );
    case "evidence-panel":
      return (
        <EvidencePanelBlock block={block as BlockPayload<"evidence-panel">} blockId={blockId} />
      );
    case "pipeline-board":
      return (
        <PipelineBoardBlock block={block as BlockPayload<"pipeline-board">} blockId={blockId} />
      );
    case "cpv-explorer":
      return <CpvExplorerBlock block={block as BlockPayload<"cpv-explorer">} blockId={blockId} />;
    case "company-snapshot":
      return (
        <CompanySnapshotBlock
          block={block as BlockPayload<"company-snapshot">}
          blockId={blockId}
        />
      );
    case "choice-prompt":
      return <ChoicePromptBlock block={block as BlockPayload<"choice-prompt">} />;
    case "filter-refine":
      return <FilterRefineBlock block={block as BlockPayload<"filter-refine">} />;
    default: {
      // Exhaustiveness guard: a new kind lands here as a type error.
      const never: never = kind;
      return never;
    }
  }
}

export function IrisBlock({
  state,
  blockId,
}: {
  state: BlockState<BlockKind>;
  blockId: string;
}) {
  switch (state.status) {
    case "loading":
      return <BlockSkeleton kind={state.kind} title={state.title} />;
    case "error":
      return <BlockNotice kind={state.kind} message={state.message} />;
    case "ready":
      return <ReadyBlock kind={state.kind} block={state.block} blockId={blockId} />;
  }
}
