"use client";

import { useCallback, useEffect, useState } from "react";

import type { WireThreadSummary } from "@/lib/ai/agent/wire";

/**
 * The sessions sidebar's data: list, create, rename, delete against
 * /api/chat/threads. Creation returns the new thread so the caller can
 * navigate to it.
 */
export function useChatSessions() {
  const [sessions, setSessions] = useState<WireThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/chat/threads");
      if (!response.ok) return;
      const json = (await response.json()) as { threads: WireThreadSummary[] };
      setSessions(json.threads);
    } catch {
      // Listing is non-critical; the active conversation still works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred so setState runs outside the effect body (repo lint pattern).
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const create = useCallback(
    async (tenderId?: string): Promise<WireThreadSummary | null> => {
      const response = await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tenderId ? { tenderId } : {}),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { thread: WireThreadSummary };
      await refresh();
      return json.thread;
    },
    [refresh],
  );

  const rename = useCallback(
    async (threadId: string, title: string) => {
      const response = await fetch(`/api/chat/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (response.ok) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === threadId ? { ...session, title } : session,
          ),
        );
      }
    },
    [],
  );

  const remove = useCallback(async (threadId: string) => {
    const response = await fetch(`/api/chat/threads/${threadId}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setSessions((prev) => prev.filter((session) => session.id !== threadId));
    }
  }, []);

  return { sessions, loading, refresh, create, rename, remove };
}
