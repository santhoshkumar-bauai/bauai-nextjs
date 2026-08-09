import { describe, expect, it } from "vitest";
import { distanceKm } from "./distance.ts";

const BERLIN = { lat: 52.52, lng: 13.405 };
const HAMBURG = { lat: 53.5511, lng: 9.9937 };
const MUNICH = { lat: 48.1351, lng: 11.582 };

describe("distanceKm", () => {
  it("measures a known German city pair", () => {
    // Berlin–Hamburg is ~255 km as the crow flies.
    expect(distanceKm(BERLIN, HAMBURG)).toBe(255);
  });

  it("is symmetric", () => {
    expect(distanceKm(BERLIN, MUNICH)).toBe(distanceKm(MUNICH, BERLIN));
  });

  it("is zero for the same point", () => {
    expect(distanceKm(BERLIN, BERLIN)).toBe(0);
  });

  it("returns null when either side is unknown", () => {
    expect(distanceKm(null, BERLIN)).toBeNull();
    expect(distanceKm(BERLIN, null)).toBeNull();
  });

  it("returns null for non-finite coordinates", () => {
    expect(distanceKm(BERLIN, { lat: Number.NaN, lng: 13 })).toBeNull();
  });
});
