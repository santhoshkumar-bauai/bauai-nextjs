/**
 * Model content → user-visible text. Thinking models (gemini-3.5-flash and
 * kin) return content as an ARRAY of parts (reasoning + text) instead of a
 * plain string — treating that as "no content" is what made finished answers
 * render as empty bubbles. Reasoning parts are deliberately dropped; only
 * text parts are user-facing.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const block = part as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("");
}
