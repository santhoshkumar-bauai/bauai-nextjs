import { IngestionError } from "../http/errors.ts";
import { exponentialBackoffMs, MINUTE, SECOND } from "../utils/time.ts";

export { IngestionError };

/**
 * Retry delay for a failed job, implementing the section 11.1 table.
 *
 * `Retry-After` always wins when the source supplied one. Otherwise the schedule
 * is exponential with jitter from a 30-second base — roughly 30 s, 2 m, 10 m,
 * 30 m, 2 h — and authentication failures never reach here because they are not
 * retryable.
 */
export function parseRetryAfterFallback(error: unknown, attempt: number): number {
  if (error instanceof IngestionError) {
    if (error.retryAfterMs !== undefined) {
      // A source that documents a wait, such as Contracts Finder's 5 minutes on
      // throttling, must be obeyed even when it is longer than our backoff.
      return Math.max(error.retryAfterMs, SECOND);
    }
    if (error.failureClass === "RATE_LIMITED") {
      return Math.max(exponentialBackoffMs(attempt, 30 * SECOND), 30 * SECOND);
    }
    if (error.failureClass === "MONGO_TRANSIENT") {
      // The driver already retried; requeue quickly rather than waiting minutes.
      return Math.min(exponentialBackoffMs(attempt, 2 * SECOND), MINUTE);
    }
    if (error.failureClass === "CIRCUIT_OPEN") {
      return Math.max(error.retryAfterMs ?? 5 * MINUTE, MINUTE);
    }
  }
  return exponentialBackoffMs(attempt, 30 * SECOND);
}

/** Whether a failure should count against the source circuit breaker (§11.2). */
export function countsAgainstCircuit(error: unknown): boolean {
  if (!(error instanceof IngestionError)) return false;
  return (
    error.failureClass === "TRANSIENT_HTTP" ||
    error.failureClass === "RATE_LIMITED" ||
    error.failureClass === "AUTHENTICATION"
  );
}
