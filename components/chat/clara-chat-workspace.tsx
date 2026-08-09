"use client";

import { PanelLeft, Sparkles, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import type { WireThreadSummary } from "@/lib/ai/agent/wire";
import { ChatInput } from "./chat-input";
import { MessageList } from "./message-list";
import { SessionsSidebar } from "./sessions-sidebar";
import { useChatSessions } from "./use-chat-sessions";
import { useClaraChat } from "./use-clara-chat";

/**
 * The full-page Clara chat (ChatGPT-style): sessions sidebar + thread view.
 * The URL is the source of truth — `?thread={id}` selects a session,
 * `?tender={tenderId}` boots the company's tender thread (deep link from the
 * tender dialog) and then normalizes to `?thread=`.
 */
export function ClaraChatWorkspace() {
  const t = useTranslations("Chat");
  const locale = useLocale() as "en" | "de";
  const router = useRouter();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("thread");
  const tenderId = searchParams.get("tender");

  const sessionsApi = useChatSessions();
  const { create: createSession, refresh: refreshSessions } = sessionsApi;
  const endpoint = threadId ? `/api/chat/threads/${threadId}` : null;
  const chat = useClaraChat(endpoint, { locale });

  const [sidebarOpen, setSidebarOpen] = useState(false);
  // A message typed before any session exists: create → navigate → send.
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const booting = useRef(false);

  // ?tender= deep link: ensure the tender thread once, then normalize the URL.
  useEffect(() => {
    if (!tenderId || threadId || booting.current) return;
    booting.current = true;
    void createSession(tenderId).then((thread) => {
      booting.current = false;
      if (thread) router.replace(`/chat?thread=${thread.id}`);
      else router.replace("/chat");
    });
  }, [tenderId, threadId, router, createSession]);

  // Deliver a message that was typed before its session existed.
  useEffect(() => {
    if (!pendingMessage || !endpoint || chat.loading) return;
    const message = pendingMessage;
    // Deferred so setState runs outside the effect body (repo lint pattern).
    const timer = setTimeout(() => {
      setPendingMessage(null);
      chat.send(message);
    }, 0);
    return () => clearTimeout(timer);
  }, [pendingMessage, endpoint, chat]);

  const activeSession =
    sessionsApi.sessions.find((session) => session.id === threadId) ?? null;

  // The server titles a fresh session from its first message; re-list once
  // after the first exchange so "New conversation" becomes the real title
  // (and the recency sort updates). The ref stops repeat fetches per thread.
  const titleRefreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || chat.sending || chat.messages.length === 0) return;
    if (titleRefreshed.current === threadId) return;
    titleRefreshed.current = threadId;
    const timer = setTimeout(() => void refreshSessions(), 0);
    return () => clearTimeout(timer);
  }, [threadId, chat.sending, chat.messages.length, refreshSessions]);

  const selectSession = (session: WireThreadSummary) => {
    setSidebarOpen(false);
    router.replace(`/chat?thread=${session.id}`);
  };

  const startChat = async (firstMessage?: string) => {
    const thread = await createSession();
    if (!thread) return;
    if (firstMessage) setPendingMessage(firstMessage);
    setSidebarOpen(false);
    router.replace(`/chat?thread=${thread.id}`);
  };

  const deleteSession = async (id: string) => {
    await sessionsApi.remove(id);
    if (id === threadId) router.replace("/chat");
  };

  const headerTitle = activeSession
    ? activeSession.kind === "tender"
      ? (activeSession.tenderTitle ?? t("sessions.untitled"))
      : (activeSession.title ?? t("sessions.untitled"))
    : t("title");

  const sidebar = (
    <SessionsSidebar
      sessions={sessionsApi.sessions}
      loading={sessionsApi.loading}
      activeThreadId={threadId}
      onSelect={selectSession}
      onNewChat={() => void startChat()}
      onRename={(id, title) => void sessionsApi.rename(id, title)}
      onDelete={(id) => void deleteSession(id)}
    />
  );

  const suggestionKeys = ["findTenders", "companyDocs", "profile"] as const;

  return (
    <div className="flex h-svh w-full bg-background">
      {/* Desktop sidebar */}
      <div className="hidden w-[280px] shrink-0 flex-col border-r border-border bg-muted/20 p-3 md:flex">
        <div className="flex items-center gap-2 px-1 pb-3">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{t("title")}</span>
        </div>
        {sidebar}
      </div>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label={t("sessions.cancel")}
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 bg-foreground/30"
          />
          <div className="absolute inset-y-0 left-0 flex w-[290px] flex-col bg-background p-3 shadow-xl">
            <div className="flex items-center justify-between px-1 pb-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="size-4 text-primary" />
                {t("title")}
              </span>
              <button
                type="button"
                aria-label={t("sessions.cancel")}
                onClick={() => setSidebarOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            type="button"
            aria-label={t("sessions.title")}
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden"
          >
            <PanelLeft className="size-4" />
          </button>
          <h1 className="truncate text-sm font-semibold text-foreground">
            {headerTitle}
          </h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {!threadId ? (
              <div className="flex flex-col items-center gap-6 pt-16 text-center">
                <div className="grid size-12 place-items-center rounded-2xl bg-primary/10">
                  <Sparkles className="size-6 text-primary" />
                </div>
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("title")}
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    {t("globalEmpty")}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {suggestionKeys.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => void startChat(t(`suggestions.${key}`))}
                      className="rounded-full border border-border bg-background px-3.5 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      {t(`suggestions.${key}`)}
                    </button>
                  ))}
                </div>
              </div>
            ) : chat.loading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("loading")}
              </p>
            ) : (
              <MessageList
                messages={chat.messages}
                streamingText={chat.streamingText}
                verdicts={chat.verdicts}
                density="comfortable"
                emptyText={
                  activeSession?.kind === "tender" ? t("empty") : t("globalEmpty")
                }
                pending={chat.sending || pendingMessage !== null}
                activeTool={chat.activeTool}
                activeStage={chat.activeStage}
              />
            )}
            {chat.error && (
              <p className="pt-3 text-center text-xs text-rose-600">
                {chat.error === "rate_limited" ? t("rateLimited") : t("error")}
              </p>
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl">
          <ChatInput
            onSend={(text) => {
              if (threadId) chat.send(text);
              else void startChat(text);
            }}
            onStop={chat.stop}
            sending={chat.sending || pendingMessage !== null}
            density="comfortable"
            placeholder={
              activeSession?.kind === "tender"
                ? t("placeholder")
                : t("globalPlaceholder")
            }
          />
        </div>
      </div>
    </div>
  );
}
