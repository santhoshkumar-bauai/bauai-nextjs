import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { assembleQueryText } from "./cpv-derive.ts";

describe("assembleQueryText", () => {
  it("leads with the title and lot titles — where lot-split notices name the trade", () => {
    const text = assembleQueryText({
      _id: new ObjectId(),
      title: "Neubau FFW Schwarzholz",
      description: "a".repeat(500),
      lots: [{ title: "Los 4 Elektroinstallation", description: null }],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Neubau FFW Schwarzholz");
    expect(lines[1]).toBe("Los 4 Elektroinstallation");
    // Description is truncated so boilerplate cannot drown the trade terms.
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it("skips absent parts without leaving blank lines", () => {
    const text = assembleQueryText({
      _id: new ObjectId(),
      title: "Dachsanierung Rathaus",
      description: null,
      lots: [],
    });
    expect(text).toBe("Dachsanierung Rathaus");
  });

  it("returns an empty string for a contentless tender", () => {
    expect(
      assembleQueryText({ _id: new ObjectId(), title: null, description: "", lots: [] }),
    ).toBe("");
  });
});
