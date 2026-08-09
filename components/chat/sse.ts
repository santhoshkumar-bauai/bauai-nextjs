import type { ClaraSseEvent } from "@/lib/ai/agent/wire";

/**
 * Incremental SSE frame parser for fetch-reader streams (SSE-over-POST has no
 * EventSource). Feed it decoded text chunks; it yields complete events and
 * buffers partial frames. Pure — unit-testable.
 */
export class SseFrameParser {
  private buffer = "";

  push(chunk: string): ClaraSseEvent[] {
    this.buffer += chunk;
    const events: ClaraSseEvent[] = [];

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");

      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue; // comment/heartbeat frame
      try {
        events.push(JSON.parse(dataLine.slice(6)) as ClaraSseEvent);
      } catch {
        // Malformed frame — skip rather than kill the stream.
      }
    }
    return events;
  }
}
