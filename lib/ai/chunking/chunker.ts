import { extractLegalRefs } from "./legal-refs.ts";

/**
 * Section-aware chunker over flat extracted text (roadmap §16.1, adapted to
 * the current parser output: no page/bbox anchors yet — exact character
 * offsets into the source text are the anchor, and `text.slice(charStart,
 * charEnd)` must reproduce each chunk's raw span byte-for-byte).
 *
 * Strategy: split into blocks on blank lines, detect numbered/uppercase
 * headings to maintain a best-effort `sectionPath`, then greedily pack blocks
 * into chunks of `targetTokens` (hard cap `maxTokens`, ~4 chars/token
 * heuristic — no tokenizer dependency), starting each chunk with a
 * one-sentence overlap from the previous chunk (§16.1: sentence overlap, not
 * arbitrary token overlap).
 */

export interface ChunkerOptions {
  targetTokens: number;
  maxTokens: number;
}

export interface RawChunk {
  text: string;
  /** Exact offsets into the ORIGINAL text (overlap sentence not included). */
  charStart: number;
  charEnd: number;
  sectionPath: string[];
  legalRefs: string[];
  tokenCount: number;
  chunkIndex: number;
}

const CHARS_PER_TOKEN = 4;

interface Block {
  text: string;
  start: number;
  end: number;
  isHeading: boolean;
}

/** Numbered ("3.", "3.2", "IV.") or short shouting lines read as headings. */
function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/^\d+(\.\d+)*\.?\s+\S/.test(trimmed)) return true;
  if (/^[IVXLC]+\.\s+\S/.test(trimmed)) return true;
  if (
    trimmed.length >= 6 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-ZÄÖÜ]{3}/.test(trimmed) &&
    !/\d{4}/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/** Heading nesting level from its numbering ("3.2.1" → 3); 1 otherwise. */
function headingLevel(line: string): number {
  const match = line.trim().match(/^(\d+(?:\.\d+)*)\.?\s/);
  if (!match) return 1;
  return match[1].split(".").length;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  // Blank-line separated; single-line blocks may be headings.
  const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index;
    const trimmedLength = raw.trimEnd().length;
    if (raw.trim().length === 0) continue;
    const lines = raw.split("\n");
    blocks.push({
      text: raw,
      start,
      end: start + trimmedLength,
      isHeading: lines.length === 1 && looksLikeHeading(raw),
    });
  }
  return blocks;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Last sentence of a text, for the one-sentence overlap. */
function lastSentence(text: string): string {
  const trimmed = text.trim();
  const matches = trimmed.match(/[^.!?]*[.!?]+["')\]]*\s*$/);
  const sentence = (matches?.[0] ?? "").trim();
  if (!sentence || sentence.length > 300) return "";
  return sentence;
}

/** Hard-split an oversized block on sentence boundaries, then raw length. */
function splitOversized(block: Block, maxChars: number): Block[] {
  if (block.end - block.start <= maxChars) return [block];
  const pieces: Block[] = [];
  let cursor = block.start;
  const text = block.text;
  let localOffset = 0;

  while (localOffset < text.length) {
    let sliceEnd = Math.min(localOffset + maxChars, text.length);
    if (sliceEnd < text.length) {
      const window = text.slice(localOffset, sliceEnd);
      const lastBoundary = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf(".\n"),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
      );
      if (lastBoundary > maxChars * 0.4) sliceEnd = localOffset + lastBoundary + 1;
    }
    const pieceText = text.slice(localOffset, sliceEnd);
    pieces.push({
      text: pieceText,
      start: cursor,
      end: cursor + pieceText.trimEnd().length,
      isHeading: false,
    });
    cursor += pieceText.length;
    localOffset = sliceEnd;
  }
  return pieces;
}

export function chunkText(text: string, options: ChunkerOptions): RawChunk[] {
  const targetChars = options.targetTokens * CHARS_PER_TOKEN;
  const maxChars = options.maxTokens * CHARS_PER_TOKEN;

  const chunks: RawChunk[] = [];
  const sectionStack: Array<{ level: number; title: string }> = [];

  let currentBlocks: Block[] = [];
  let currentSection: string[] = [];
  let previousChunkText = "";

  const flush = () => {
    if (currentBlocks.length === 0) return;
    const start = currentBlocks[0].start;
    const end = currentBlocks[currentBlocks.length - 1].end;
    const raw = text.slice(start, end);
    const overlap = lastSentence(previousChunkText);
    const chunkBody = overlap ? `${overlap}\n${raw}` : raw;
    chunks.push({
      text: chunkBody,
      charStart: start,
      charEnd: end,
      sectionPath: [...currentSection],
      legalRefs: extractLegalRefs(raw),
      tokenCount: estimateTokens(chunkBody),
      chunkIndex: chunks.length,
    });
    previousChunkText = raw;
    currentBlocks = [];
  };

  for (const block of splitBlocks(text)) {
    if (block.isHeading) {
      flush();
      const level = headingLevel(block.text);
      while (
        sectionStack.length > 0 &&
        sectionStack[sectionStack.length - 1].level >= level
      ) {
        sectionStack.pop();
      }
      sectionStack.push({ level, title: block.text.trim() });
      currentSection = sectionStack.map((s) => s.title);
      continue;
    }

    for (const piece of splitOversized(block, maxChars)) {
      const currentSize = currentBlocks.length
        ? currentBlocks[currentBlocks.length - 1].end - currentBlocks[0].start
        : 0;
      const pieceSize = piece.end - piece.start;
      if (currentBlocks.length > 0 && currentSize + pieceSize > targetChars) {
        flush();
      }
      currentBlocks.push(piece);
    }
  }
  flush();

  return chunks;
}
