/**
 * Template completion context detection.
 *
 * Regex-driven on purpose: completion runs on every keystroke, against templates
 * that are syntactically broken while being typed, so a parser is both too slow
 * and too strict here. Works on plain document text, so the Extension Host and
 * the language server share one answer.
 * @module
 */

import type { DocumentPosition, DocumentView } from "./document";
import type { CoreRange } from "./language-types";

/** How many lines back a multi-line opening tag is searched for. */
const MULTI_LINE_TAG_SEARCH_LIMIT = 50;

/** Word characters that make up a replaceable completion token. */
const COMPLETION_WORD_PATTERN = /[\w-]+/g;

/** What the cursor is completing in a template. */
export type CompletionContextKind = "tag" | "attribute" | "pipe" | "structural-directive" | "none";

/** The template position resolved into everything ranking needs, with no editor types. */
export interface CompletionContextData {
  context: CompletionContextKind;
  filterText: string;
  replacementRange: CoreRange | undefined;
  triggerChar: "[" | "*" | undefined;
  linePrefix: string;
  /**
   * The tag the cursor is inside, when it is inside one.
   *
   * Carried on the context because it is already known here: the search that decided
   * there is a tag at all read its name on the way. Working it out a second time from
   * {@link CompletionContextData.linePrefix} means finding the `<` again, which a
   * bracket inside an attribute value — `[title]="a < b"` — answers wrongly, and which
   * a tag opened on an earlier line does not answer at all.
   */
  tagName: string | undefined;
  hasAttributeContext: boolean;
  hasTagContext: boolean;
  hasPipeContext: boolean;
}

type TagContext = { tagContent: string; isNewTag: boolean; tagName: string };

type AttributeContext = {
  context: "attribute" | "structural-directive";
  filterText: string;
  triggerChar: "[" | "*" | undefined;
};

/**
 * Detects what the cursor is completing, handling tags that span several lines.
 * @param document The document holding the template.
 * @param position The cursor position.
 */
export function detectCompletionContext(document: DocumentView, position: DocumentPosition): CompletionContextData {
  const lines = document.getText().split(/\r?\n/);
  const lineText = lines[position.line] ?? "";
  const linePrefix = lineText.slice(0, position.character);
  let filterText = "";
  let context: CompletionContextKind = "none";
  let triggerChar: "[" | "*" | undefined;
  let tagName: string | undefined;

  // One walk decides both questions, because both need the same state: whether the
  // cursor is inside a comment, and which tag it is inside if it is inside one.
  const cursor = scanToCursor(lines, position);
  const pipeIndex = linePrefix.lastIndexOf("|");
  const { lastOpen: localOpenTagIndex, lastClose: localCloseTagIndex } = scanBrackets(linePrefix);

  if (cursor.inComment) {
    // Nothing here is markup or an expression, whatever it looks like.
  } else if (pipeIndex > localOpenTagIndex && pipeIndex > localCloseTagIndex) {
    context = "pipe";
    const textAfterPipe = linePrefix.substring(pipeIndex + 1);
    filterText = textAfterPipe.trim();
  } else {
    const tagContext = cursor.openTag && validateTagContext(buildTagContent(lines, cursor.openTag, position));

    if (tagContext) {
      const { tagContent, isNewTag } = tagContext;
      tagName = tagContext.tagName || undefined;

      if (isNewTag) {
        // We're right after "<", completing the tag name
        context = "tag";
        filterText = tagContent;
      } else {
        // We're inside a tag, completing attributes
        const attributeContext = parseAttributeContext(tagContent);
        context = attributeContext.context;
        filterText = attributeContext.filterText;
        triggerChar = attributeContext.triggerChar;
      }
    }
  }

  return {
    context,
    filterText,
    replacementRange: findWordRangeAt(lineText, position),
    triggerChar,
    linePrefix,
    tagName,
    hasAttributeContext: context === "attribute" || context === "structural-directive",
    hasTagContext: context === "tag",
    hasPipeContext: context === "pipe",
  };
}

/**
 * Returns the word surrounding the cursor, which a completion item replaces.
 * @internal
 */
function findWordRangeAt(lineText: string, position: DocumentPosition): CoreRange | undefined {
  COMPLETION_WORD_PATTERN.lastIndex = 0;
  for (const match of lineText.matchAll(COMPLETION_WORD_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= position.character && position.character <= end) {
      return {
        start: { line: position.line, character: start },
        end: { line: position.line, character: end },
      };
    }
  }

  return undefined;
}

/**
 * Validates tag content and returns context if valid.
 * @internal
 */
function validateTagContext(tagContent: string): TagContext | null {
  const firstWordMatch = tagContent.match(/^[a-zA-Z0-9-]+/);
  const tagName = firstWordMatch ? firstWordMatch[0] : "";
  const contentAfterTag = tagContent.substring(tagName.length);

  // Check if we're still typing the tag name (no space after tag name)
  if (contentAfterTag.length > 0 && !/^\s/.test(contentAfterTag)) {
    return null;
  }

  const isNewTag = !/\s/.test(tagContent);
  return { tagContent, isNewTag, tagName };
}

/** What one walk from above the cursor down to it establishes. @internal */
interface CursorScan {
  /** Where the tag the cursor sits inside was opened, or nothing when it sits in text. */
  openTag: { line: number; char: number } | null;
  /** Whether the cursor sits inside an HTML comment. */
  inComment: boolean;
}

/**
 * Reads the template down to the cursor and reports what surrounds it.
 *
 * Scanned forwards, from a bounded number of lines above the cursor down to it, rather
 * than backwards line by line. Backwards cannot work: whether a `<` opens a tag depends
 * on everything before it — a `<` inside an attribute value spanning several lines is a
 * comparison, and a line read on its own has no way to know that. Forwards, the state
 * that decides it is simply what the scan has accumulated by the time it gets there.
 *
 * The window is what makes this affordable on every keystroke, and it is also its one
 * limitation: a tag opened further up than {@link MULTI_LINE_TAG_SEARCH_LIMIT} lines is
 * not found, and a window that happens to start inside a value or a comment reads the
 * first few characters as if it did not.
 * @internal
 */
function scanToCursor(lines: string[], position: DocumentPosition): CursorScan {
  const firstLine = Math.max(0, position.line - MULTI_LINE_TAG_SEARCH_LIMIT);
  let state = OUTSIDE_TAG;
  let openedAt: { line: number; char: number } | null = null;

  for (let i = firstLine; i <= position.line; i++) {
    const line = lines[i] ?? "";
    const segment = i === position.line ? line.substring(0, position.character) : line;
    const scan = scanBrackets(segment, state);

    if (!scan.state.inTag) {
      // Whatever was open closed in this segment, and nothing reopened.
      openedAt = null;
    } else if (scan.lastOpen !== -1) {
      // A `<` after the last `>` is the one still standing open.
      openedAt = { line: i, char: scan.lastOpen };
    }
    state = scan.state;
  }

  return { openTag: openedAt, inComment: state.inComment };
}

/** The quote characters an attribute value may be written with. @internal */
type QuoteChar = '"' | "'";

/**
 * Where a scan of one fragment ended, so the next fragment can carry on from it.
 * @internal
 */
interface ScanState {
  /** Whether the scan is between a `<` and its `>`. */
  inTag: boolean;
  /** Whether the scan is inside an HTML comment, where nothing is markup. */
  inComment: boolean;
  /** The quote the scan is inside, when it is inside one. */
  quote: QuoteChar | undefined;
}

/** A scan that has not started, or has finished a tag. @internal */
const OUTSIDE_TAG: ScanState = { inTag: false, inComment: false, quote: undefined };

/** A scan inside `<!-- ... -->`. @internal */
const INSIDE_COMMENT: ScanState = { inTag: false, inComment: true, quote: undefined };

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/**
 * Finds the `<` and `>` in a fragment that are markup, and says where it left off.
 *
 * Three rules, and each of them is a bug someone hit:
 *
 * A quote only delimits *inside a tag*. In text content it is a character like any
 * other, so `<p>Don't</p>` opens no attribute value — reading it as one swallows every
 * `<` after it and completion dies for the rest of the file.
 *
 * A comment is not a tag, and nothing inside one is markup. `<!--` reads like the start
 * of a tag named `!--`, and then an apostrophe in the prose inside it opens a value
 * that never closes — the same failure, reached a different way.
 *
 * A bracket inside an attribute value is not markup: `*ngIf="count > 5"` does not close
 * the tag it sits in, and `(click)="go(x => x.id)"` does not either.
 *
 * The state is returned rather than reset per line, because a value or a comment may
 * span lines — `[title]="count` on one and `> 5"` on the next — and a fresh scan of the
 * second line would call that `>` the end of the tag.
 * @param text One line, or the part of one before the cursor.
 * @param from Where a previous fragment left off; the start of a document by default.
 * @internal
 */
function scanBrackets(
  text: string,
  from: ScanState = OUTSIDE_TAG
): { lastOpen: number; lastClose: number; state: ScanState } {
  let state = from;
  let lastOpen = -1;
  let lastClose = -1;

  for (let i = 0; i < text.length; i++) {
    const comment = readComment(text, i, state);
    if (comment) {
      state = comment.state;
      i = comment.resumeAt;
      continue;
    }

    const step = readCharacter(text[i], i > 0 && text[i - 1] === "\\", state);
    state = step.state;
    if (step.bracket === "<") {
      lastOpen = i;
    } else if (step.bracket === ">") {
      lastClose = i;
    }
  }

  return { lastOpen, lastClose, state };
}

/**
 * Handles the two places a comment changes a scan: where one opens, and where the one
 * being scanned ends. Answers nothing when the position is neither.
 * @param text The fragment being scanned.
 * @param index Where the scan is.
 * @param state Where the scan was.
 * @internal
 */
function readComment(
  text: string,
  index: number,
  state: ScanState
): { state: ScanState; resumeAt: number } | undefined {
  if (state.inComment) {
    return text.startsWith(COMMENT_CLOSE, index)
      ? { state: OUTSIDE_TAG, resumeAt: index + COMMENT_CLOSE.length - 1 }
      : { state, resumeAt: index };
  }
  if (!state.inTag && text.startsWith(COMMENT_OPEN, index)) {
    return { state: INSIDE_COMMENT, resumeAt: index + COMMENT_OPEN.length - 1 };
  }
  return undefined;
}

/**
 * What one character does to a scan: where it leaves it, and whether it was markup.
 * @param char The character read.
 * @param escaped Whether a backslash precedes it.
 * @param state Where the scan was.
 * @internal
 */
function readCharacter(
  char: string,
  escaped: boolean,
  state: ScanState
): { state: ScanState; bracket: "<" | ">" | undefined } {
  if (!state.inTag) {
    // Text content: only a `<` means anything, and a quote is a character like any other.
    return char === "<" ? { state: { ...OUTSIDE_TAG, inTag: true }, bracket: "<" } : { state, bracket: undefined };
  }
  if (escaped) {
    return { state, bracket: undefined };
  }
  if (char === '"' || char === "'") {
    return { state: { ...state, quote: nextQuote(char, state.quote) }, bracket: undefined };
  }
  if (state.quote) {
    return { state, bracket: undefined };
  }
  if (char === ">") {
    return { state: OUTSIDE_TAG, bracket: ">" };
  }
  return { state, bracket: char === "<" ? "<" : undefined };
}

/**
 * The quote a scan is inside after reading one, or nothing when it just left one. A
 * quote of the other kind inside a literal is content, not a delimiter.
 * @internal
 */
function nextQuote(char: QuoteChar, current: QuoteChar | undefined): QuoteChar | undefined {
  if (current === undefined) {
    return char;
  }
  return current === char ? undefined : current;
}

/**
 * The tag as written so far: everything between its `<` and the cursor.
 *
 * Every line is cut at the cursor when it is the cursor's line, including the line the
 * tag opened on. A tag that opens and is still being typed on one line — the usual case,
 * and the only one an inline template in a decorator has room for — otherwise picks up
 * whatever follows the cursor on that line, and stops parsing as a tag at all.
 * @internal
 */
function buildTagContent(
  lines: string[],
  openTagPosition: { line: number; char: number },
  currentPosition: DocumentPosition
): string {
  let tagContent = "";

  for (let i = openTagPosition.line; i <= currentPosition.line; i++) {
    const line = lines[i] ?? "";
    const end = i === currentPosition.line ? currentPosition.character : line.length;
    const from = i === openTagPosition.line ? openTagPosition.char + 1 : 0;
    const segment = line.substring(from, end);

    tagContent += i === openTagPosition.line ? segment : ` ${segment.trim()}`;
  }

  return tagContent;
}

/**
 * Parses attribute context from tag content.
 * @internal
 */
function parseAttributeContext(tagContent: string): AttributeContext {
  const lastSpaceIndex = tagContent.lastIndexOf(" ");
  const partialWord = tagContent.substring(lastSpaceIndex + 1);

  if (partialWord.startsWith("[")) {
    return {
      context: "attribute",
      filterText: partialWord.substring(1),
      triggerChar: "[",
    };
  }

  if (partialWord.startsWith("*")) {
    return {
      context: "structural-directive",
      filterText: partialWord.substring(1),
      triggerChar: "*",
    };
  }

  return {
    context: "attribute",
    filterText: partialWord.length > 0 ? partialWord : "",
    triggerChar: undefined,
  };
}
