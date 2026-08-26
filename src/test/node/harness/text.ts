/**
 * Applying text edits, which only a test needs to do.
 *
 * In production the editor applies them; here, a test that wants to know what a plan
 * produces has to apply the plan itself. Kept beside the tests rather than in core,
 * because shipping an applier nothing ships would be shipping dead code.
 * @module
 */

import type { CoreRange } from "../../../core/language-types";

interface TextEdit {
  range: CoreRange;
  newText: string;
}

/**
 * Applies non-overlapping edits to text, exactly as an editor would.
 *
 * Applied last-first, so each edit's offsets still describe the text it was computed
 * against; applying them in order would shift every range after the first.
 * @param text The text the edits were computed from.
 * @param edits Non-overlapping edits, in any order.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const offsets = lineOffsets(text);
  const ordered = [...edits].sort(
    (left, right) => offsetOf(offsets, right.range.start) - offsetOf(offsets, left.range.start)
  );

  let result = text;
  for (const edit of ordered) {
    const start = offsetOf(offsets, edit.range.start);
    const end = offsetOf(offsets, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

/** @internal */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

/** @internal */
function offsetOf(offsets: readonly number[], position: CoreRange["start"]): number {
  return (offsets[position.line] ?? offsets[offsets.length - 1]) + position.character;
}
