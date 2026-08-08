import { describe, expect, it } from "vitest";

import { SseFrameParser } from "./sse.ts";

describe("SseFrameParser", () => {
  it("parses complete frames", () => {
    const parser = new SseFrameParser();
    const events = parser.push(
      'event: token\ndata: {"type":"token","delta":"Hallo"}\n\n',
    );
    expect(events).toEqual([{ type: "token", delta: "Hallo" }]);
  });

  it("buffers partial frames across pushes", () => {
    const parser = new SseFrameParser();
    expect(parser.push('event: token\ndata: {"type":"tok')).toEqual([]);
    expect(parser.push('en","delta":"x"}\n\n')).toEqual([
      { type: "token", delta: "x" },
    ]);
  });

  it("handles multiple frames in one chunk and skips heartbeats", () => {
    const parser = new SseFrameParser();
    const events = parser.push(
      ': keep-alive\n\n' +
        'event: tool\ndata: {"type":"tool","name":"x","status":"start"}\n\n' +
        'event: token\ndata: {"type":"token","delta":"a"}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("tool");
    expect(events[1].type).toBe("token");
  });

  it("skips malformed JSON without dying", () => {
    const parser = new SseFrameParser();
    const events = parser.push(
      "event: token\ndata: {broken\n\n" +
        'event: token\ndata: {"type":"token","delta":"ok"}\n\n',
    );
    expect(events).toEqual([{ type: "token", delta: "ok" }]);
  });
});
