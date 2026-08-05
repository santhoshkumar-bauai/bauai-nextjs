import { ingestionEnv } from "../config/env.ts";
import { createRedis } from "../queue/client.ts";
import type {
  BusinessCategory,
  OutboxEventType,
  TenderSourceCode,
  TenderStatus,
} from "../types.ts";

/**
 * Application-side consumer of the relay's pub/sub channel (§5.1).
 *
 * The payload deliberately carries only what a subscriber needs to decide whether
 * to react — status, category, CPV, countries, dates — not the whole tender. A
 * client that cares reads the current document from `tenders`, which is always the
 * authority; the event is a hint that it changed.
 */
export interface TenderChangeEvent {
  eventType: OutboxEventType;
  aggregateId: string;
  aggregateVersion: number;
  canonicalKey: string;
  status: TenderStatus;
  businessCategory: BusinessCategory;
  cpvCodes: string[];
  countries: string[];
  regions: string[];
  submissionDeadline: string | null;
  publicationDate: string | null;
  sources: TenderSourceCode[];
  /** True for historical inserts and deadline sweeps; do not raise user alerts. */
  suppressNotifications: boolean;
  emittedAt: string;
}

export interface SubscriptionOptions {
  onEvent(event: TenderChangeEvent): void | Promise<void>;
  onError?(error: Error): void;
  signal?: AbortSignal;
}

/**
 * Subscribes to committed tender changes. Returns an unsubscribe function.
 *
 * A dedicated connection is used because a Redis client in subscriber mode cannot
 * serve other commands.
 */
export function subscribeToTenderChanges(options: SubscriptionOptions): () => void {
  const client = createRedis("outbox-subscriber");
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    void client.quit().catch(() => undefined);
  };

  client.on("error", (error) => options.onError?.(error));

  void client.subscribe(ingestionEnv.outbox.channel).catch((error) => {
    options.onError?.(error as Error);
    close();
  });

  client.on("message", (_channel, message) => {
    try {
      void options.onEvent(JSON.parse(message) as TenderChangeEvent);
    } catch (error) {
      // A malformed message must not tear down the subscription; the durable
      // record is still in `outbox_events` either way.
      options.onError?.(error as Error);
    }
  });

  options.signal?.addEventListener("abort", close, { once: true });
  return close;
}

export const tenderEventsChannel = ingestionEnv.outbox.channel;
