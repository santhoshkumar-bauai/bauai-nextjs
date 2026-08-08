import { describe, expect, it } from "vitest";

import { deadlineDaysLeft, deadlineUrgency } from "./deadline.ts";

const NOW = new Date(2026, 7, 10, 15, 30); // Aug 10, 2026 15:30 local

function iso(year: number, month: number, day: number, hour = 10): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("deadlineDaysLeft", () => {
  it("same day → 0 regardless of time of day", () => {
    expect(deadlineDaysLeft(iso(2026, 8, 10, 8), NOW)).toBe(0);
    expect(deadlineDaysLeft(iso(2026, 8, 10, 23), NOW)).toBe(0);
  });

  it("tomorrow → 1 even shortly after midnight", () => {
    expect(deadlineDaysLeft(iso(2026, 8, 11, 0), NOW)).toBe(1);
  });

  it("counts calendar days, not 24h periods", () => {
    // 09:00 tomorrow is <24h away from 15:30 today but is still "1 day left".
    expect(deadlineDaysLeft(iso(2026, 8, 11, 9), NOW)).toBe(1);
  });

  it("past deadlines are negative", () => {
    expect(deadlineDaysLeft(iso(2026, 8, 9, 23), NOW)).toBe(-1);
    expect(deadlineDaysLeft(iso(2026, 7, 1), NOW)).toBeLessThan(-30);
  });

  it("far future", () => {
    expect(deadlineDaysLeft(iso(2026, 8, 27), NOW)).toBe(17);
  });
});

describe("deadlineUrgency", () => {
  it("bands are correct at the boundaries", () => {
    expect(deadlineUrgency(-1)).toBe("closed");
    expect(deadlineUrgency(0)).toBe("critical");
    expect(deadlineUrgency(6)).toBe("critical");
    expect(deadlineUrgency(7)).toBe("soon");
    expect(deadlineUrgency(14)).toBe("soon");
    expect(deadlineUrgency(15)).toBe("normal");
  });
});
