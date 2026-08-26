/**
 * Turning "here is the file, rewritten" into "here is what changed".
 *
 * The import planner works by handing a file to ts-morph and reading back the result,
 * which yields a new whole document and no record of what moved. Replacing the whole
 * file with that would be correct exactly once: a second edit computed from the same
 * starting text would undo the first, an edit spanning the whole file collides with a
 * completion's own edit inside it, and every such replacement discards the user's
 * selection and folding for lines that never changed.
 *
 * So the rewrite is diffed back into the smallest set of replacements that produce it.
 * Line granularity is deliberate: the changes an import makes are whole lines — a new
 * `import` statement, a rewritten `imports: [...]` — and a finer diff would cost more
 * to compute and read no better.
 * @module
 */

import type { CoreRange } from "./language-types";

/** A replacement the caller applies to the file the diff was computed from. */
export interface TextEdit {
  range: CoreRange;
  newText: string;
}

/**
 * Above this many lines on either side, the diff is not worth computing.
 *
 * The algorithm below is quadratic in the size of the changed region. A component file
 * is tens or hundreds of lines; something far larger is not a file this extension was
 * asked to edit, and replacing it wholesale is better than stalling on it.
 */
const MAX_DIFFED_LINES = 4000;

/**
 * The edits that turn `before` into `after`.
 * @param before The text the edits will be applied to.
 * @param after The text they should produce.
 * @returns Non-overlapping edits in document order; empty when the texts are equal.
 */
export function diffToEdits(before: string, after: string): TextEdit[] {
  if (before === after) {
    return [];
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // Unchanged lines at either end are the bulk of any real file, and trimming them is
  // what keeps the quadratic part small enough to be worth running at all.
  const prefix = commonPrefixLength(beforeLines, afterLines);
  const suffix = commonSuffixLength(beforeLines, afterLines, prefix);
  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);

  if (beforeMiddle.length > MAX_DIFFED_LINES || afterMiddle.length > MAX_DIFFED_LINES) {
    return [replacement(beforeLines, prefix, beforeLines.length - suffix, afterMiddle.join(""))];
  }

  return alignLines(beforeMiddle, afterMiddle)
    .map((hunk) => replacement(beforeLines, prefix + hunk.start, prefix + hunk.end, hunk.newText))
    .filter((edit) => edit.newText !== "" || !isEmptyRange(edit.range));
}

/** One contiguous change, in indices relative to the trimmed middle. @internal */
interface Hunk {
  start: number;
  end: number;
  newText: string;
}

/**
 * Finds the contiguous regions that differ, keeping the lines both sides share.
 *
 * A longest-common-subsequence walk, which is what makes the result minimal: without it,
 * inserting one line near the top would report every line below it as changed.
 * @internal
 */
function alignLines(before: readonly string[], after: readonly string[]): Hunk[] {
  const common = longestCommonSubsequence(before, after);
  const hunks: Hunk[] = [];

  let beforeIndex = 0;
  let afterIndex = 0;
  let pending: Hunk | undefined;

  const flush = (): void => {
    if (pending) {
      hunks.push(pending);
      pending = undefined;
    }
  };

  for (const [matchedBefore, matchedAfter] of common) {
    if (beforeIndex < matchedBefore || afterIndex < matchedAfter) {
      pending = {
        start: beforeIndex,
        end: matchedBefore,
        newText: after.slice(afterIndex, matchedAfter).join(""),
      };
      flush();
    }
    beforeIndex = matchedBefore + 1;
    afterIndex = matchedAfter + 1;
  }

  if (beforeIndex < before.length || afterIndex < after.length) {
    pending = { start: beforeIndex, end: before.length, newText: after.slice(afterIndex).join("") };
    flush();
  }

  return hunks;
}

/**
 * The pairs of indices at which the two line arrays agree, as long a run as exists.
 * @internal
 */
function longestCommonSubsequence(before: readonly string[], after: readonly string[]): Array<[number, number]> {
  const lengths: number[][] = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0));

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return pairs;
}

/**
 * An edit replacing whole lines `[start, end)` of the original.
 * @internal
 */
function replacement(lines: readonly string[], start: number, end: number, newText: string): TextEdit {
  return { range: { start: startOfLine(lines, start), end: startOfLine(lines, end) }, newText };
}

/**
 * Where a line begins, including the position just past the last one.
 *
 * A file whose last line has no terminator has no position at `{ lineCount, 0 }`, so an
 * edit reaching the end has to stop at the end of the text instead.
 * @internal
 */
function startOfLine(lines: readonly string[], index: number): CoreRange["start"] {
  if (index < lines.length) {
    return { line: index, character: 0 };
  }

  const last = lines[lines.length - 1] ?? "";
  return last.endsWith("\n")
    ? { line: lines.length, character: 0 }
    : { line: lines.length - 1, character: last.length };
}

/**
 * Splits text into lines that each carry their own terminator, so joining them back
 * reproduces the text exactly — including whether it ended with a newline.
 * @internal
 */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** @internal */
function commonPrefixLength(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let count = 0;
  while (count < limit && before[count] === after[count]) {
    count += 1;
  }
  return count;
}

/** @internal */
function commonSuffixLength(before: readonly string[], after: readonly string[], prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix;
  let count = 0;
  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) {
    count += 1;
  }
  return count;
}

/** @internal */
function isEmptyRange(range: CoreRange): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
}
