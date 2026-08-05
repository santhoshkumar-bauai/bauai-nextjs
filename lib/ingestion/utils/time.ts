export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** 0-`ratio` positive jitter so pollers for different sources never align (§4.1). */
export function withJitter(ms: number, ratio = 0.2): number {
  return Math.round(ms * (1 + Math.random() * ratio));
}

export function exponentialBackoffMs(attempt: number, baseMs = 30 * SECOND): number {
  const capped = Math.min(attempt, 6);
  const ceiling = baseMs * 2 ** (capped - 1);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/** `YYYY-MM-DD` in UTC, the partition label both required sources use. */
export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function toMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

/**
 * eForms dates carry an offset (`2026-10-01+02:00`) and the time arrives in a
 * sibling element. Combining them preserves the offset that decides the legal
 * submission deadline (§6.6); date-only input is anchored at UTC midnight.
 */
export function parseOffsetDateTime(
  date: string | null | undefined,
  time?: string | null,
): Date | null {
  if (!date) return null;
  const trimmed = date.trim();
  if (!trimmed) return null;

  const match = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(trimmed);
  if (match) {
    const [, day, offset] = match;
    if (time) {
      const timeMatch = /^(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?$/.exec(time.trim());
      if (timeMatch) {
        const [, clock, timeOffset] = timeMatch;
        const zone = timeOffset ?? offset ?? "Z";
        const seconds = clock.length === 5 ? `${clock}:00` : clock;
        return toDate(`${day}T${seconds}${zone}`);
      }
    }
    return toDate(`${day}T00:00:00${offset ?? "Z"}`);
  }

  return toDate(trimmed);
}

function toDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
