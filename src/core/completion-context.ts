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
  hasAttributeContext: boolean;
  hasTagContext: boolean;
  hasPipeContext: boolean;
}

type TagContext = { tagContent: string; isNewTag: boolean };

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

  // Check for pipe context on current line first
  const pipeIndex = linePrefix.lastIndexOf("|");
  const localOpenTagIndex = linePrefix.lastIndexOf("<");
  const localCloseTagIndex = linePrefix.lastIndexOf(">");

  if (pipeIndex > localOpenTagIndex && pipeIndex > localCloseTagIndex) {
    context = "pipe";
    const textAfterPipe = linePrefix.substring(pipeIndex + 1);
    filterText = textAfterPipe.trim();
  } else {
    // Look for tag context (including multi-line tags)
    const tagContext = findTagContext(lines, position, linePrefix);

    if (tagContext) {
      const { tagContent, isNewTag } = tagContext;

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
 * Finds the tag context by looking backwards from the cursor position.
 * Handles multi-line tags.
 * @internal
 */
function findTagContext(lines: string[], position: DocumentPosition, currentLinePrefix: string): TagContext | null {
  // Check if we have an opening tag on the current line
  const currentLineContext = checkCurrentLineForTag(currentLinePrefix);
  if (currentLineContext) {
    return currentLineContext;
  }

  // No opening tag on current line, search backwards for multi-line tag
  return findMultiLineTagContext(lines, position, currentLinePrefix);
}

/**
 * Checks if the current line contains an unclosed tag.
 * @internal
 */
function checkCurrentLineForTag(linePrefix: string): TagContext | null {
  const localOpenTagIndex = linePrefix.lastIndexOf("<");
  const localCloseTagIndex = linePrefix.lastIndexOf(">");

  if (localOpenTagIndex <= localCloseTagIndex) {
    return null;
  }

  const tagContent = linePrefix.substring(localOpenTagIndex + 1);
  return validateTagContext(tagContent);
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
  return { tagContent, isNewTag };
}

/**
 * Finds multi-line tag context by searching backwards.
 * @internal
 */
function findMultiLineTagContext(
  lines: string[],
  position: DocumentPosition,
  currentLinePrefix: string
): TagContext | null {
  const openTagPosition = searchBackwardsForOpenTag(lines, position);
  if (!openTagPosition) {
    return null;
  }

  // Check if the tag is closed between opening and current position
  if (isTagClosedBetween(lines, openTagPosition, position)) {
    return null;
  }

  // Build tag content from multi-line tag
  const tagContent = buildMultiLineTagContent(lines, openTagPosition, position, currentLinePrefix);
  return validateTagContext(tagContent);
}

/**
 * Searches backwards for an unclosed opening tag.
 * @internal
 */
function searchBackwardsForOpenTag(lines: string[], position: DocumentPosition): { line: number; char: number } | null {
  let searchLine = position.line - 1;

  // Search backwards a bounded number of lines for an unclosed tag
  while (searchLine >= 0 && searchLine >= position.line - MULTI_LINE_TAG_SEARCH_LIMIT) {
    const line = lines[searchLine] ?? "";
    const lastOpenTag = line.lastIndexOf("<");
    const lastCloseTag = line.lastIndexOf(">");

    if (lastOpenTag !== -1 && (lastCloseTag === -1 || lastOpenTag > lastCloseTag)) {
      return { line: searchLine, char: lastOpenTag };
    }

    searchLine--;
  }

  return null;
}

/**
 * Checks if a tag is closed between two positions.
 * Ignores > characters inside string literals (e.g., *ngIf="value > 5").
 * @internal
 */
function isTagClosedBetween(
  lines: string[],
  openTagPosition: { line: number; char: number },
  currentPosition: DocumentPosition
): boolean {
  for (let i = openTagPosition.line; i <= currentPosition.line; i++) {
    const line = lines[i] ?? "";
    const startChar = i === openTagPosition.line ? openTagPosition.char : 0;
    const endChar = i === currentPosition.line ? currentPosition.character : line.length;
    const segment = line.substring(startChar, endChar);

    if (containsClosingTagBracket(segment)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a string contains a closing tag bracket (>) outside of string literals.
 * Handles both single and double quotes.
 *
 * Examples:
 * - '<div>' → true (has closing bracket)
 * - '*ngIf="value > 5"' → false (> is inside quotes)
 * - '[attr]="a > b" >' → true (has closing bracket outside quotes)
 * @internal
 */
function containsClosingTagBracket(text: string): boolean {
  let insideDoubleQuotes = false;
  let insideSingleQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prevChar = i > 0 ? text[i - 1] : "";

    // Skip escaped quotes
    if (prevChar === "\\") {
      continue;
    }

    // Toggle quote state
    if (char === '"' && !insideSingleQuotes) {
      insideDoubleQuotes = !insideDoubleQuotes;
      continue;
    }

    if (char === "'" && !insideDoubleQuotes) {
      insideSingleQuotes = !insideSingleQuotes;
      continue;
    }

    // Check for closing bracket outside quotes
    if (char === ">" && !insideDoubleQuotes && !insideSingleQuotes) {
      return true;
    }
  }

  return false;
}

/**
 * Builds tag content from multi-line tag.
 * @internal
 */
function buildMultiLineTagContent(
  lines: string[],
  openTagPosition: { line: number; char: number },
  currentPosition: DocumentPosition,
  currentLinePrefix: string
): string {
  let tagContent = "";

  for (let i = openTagPosition.line; i <= currentPosition.line; i++) {
    const line = lines[i] ?? "";
    if (i === openTagPosition.line) {
      tagContent += line.substring(openTagPosition.char + 1);
    } else if (i === currentPosition.line) {
      tagContent += ` ${currentLinePrefix.trimStart()}`;
    } else {
      tagContent += ` ${line.trim()}`;
    }
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
