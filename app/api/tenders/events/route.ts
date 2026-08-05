import type { NextRequest } from "next/server";

import {
  subscribeToTenderChanges,
  type TenderChangeEvent,
} from "@/lib/ingestion/outbox/subscriber";

/**
 * Server-Sent Events feed of committed tender changes (§5.1).
 *
 * The outbox relay publishes only majority-committed changes, so anything that
 * reaches a browser here is durable in MongoDB. Route Handlers are uncached by
 * default in this Next.js version, so no cache opt-out export is required.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

export async function GET(request: NextRequest) {
  const filters = parseFilters(request);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // The client vanished between the abort signal and this write.
          open = false;
        }
      };

      // Proxies commonly drop an idle connection; a comment frame keeps it warm
      // without being delivered to an EventSource listener.
      const heartbeat = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          open = false;
        }
      }, HEARTBEAT_INTERVAL_MS);

      const unsubscribe = subscribeToTenderChanges({
        signal: request.signal,
        onEvent: (event) => {
          if (matchesFilters(event, filters)) send("tender", event);
        },
        onError: (error) => send("error", { message: error.message }),
      });

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", close, { once: true });
      send("ready", { channel: "tenders", filters });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Prevents response buffering on nginx-style proxies, which would defeat
      // the point of streaming.
      "x-accel-buffering": "no",
    },
  });
}

interface EventFilters {
  cpvCodes: string[];
  countries: string[];
  statuses: string[];
  /** Suppressed events are hidden unless a client explicitly asks for them. */
  includeSuppressed: boolean;
}

function parseFilters(request: NextRequest): EventFilters {
  const params = request.nextUrl.searchParams;
  const list = (name: string) =>
    (params.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

  return {
    cpvCodes: list("cpv"),
    countries: list("country").map((value) => value.toUpperCase()),
    statuses: list("status").map((value) => value.toUpperCase()),
    includeSuppressed: params.get("includeSuppressed") === "true",
  };
}

function matchesFilters(event: TenderChangeEvent, filters: EventFilters): boolean {
  if (event.suppressNotifications && !filters.includeSuppressed) return false;
  if (filters.statuses.length && !filters.statuses.includes(event.status)) return false;
  if (
    filters.countries.length &&
    !event.countries.some((country) => filters.countries.includes(country))
  ) {
    return false;
  }
  if (filters.cpvCodes.length) {
    // Prefix matching so a division such as `45` matches `45232421`, which is how
    // buyers describe an interest in a whole CPV family.
    const matched = event.cpvCodes.some((code) =>
      filters.cpvCodes.some((filter) => code.startsWith(filter)),
    );
    if (!matched) return false;
  }
  return true;
}
