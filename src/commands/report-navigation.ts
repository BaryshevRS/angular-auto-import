import { isAbsolute } from "node:path";
import type { CoreRange } from "../core/language-types";

export interface AuditLocation {
  filePath: string;
  range: CoreRange;
}

export function decodeAuditLocationMessage(value: unknown): AuditLocation | undefined {
  if (!isRecord(value) || value.type !== "openLocation") {
    return undefined;
  }
  if (typeof value.filePath !== "string" || value.filePath.trim() === "" || !isAbsolute(value.filePath)) {
    return undefined;
  }
  if (!isRange(value.range)) {
    return undefined;
  }

  return { filePath: value.filePath, range: value.range };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRange(value: unknown): value is CoreRange {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) {
    return false;
  }

  return (
    value.end.line > value.start.line ||
    (value.end.line === value.start.line && value.end.character >= value.start.character)
  );
}

function isPosition(value: unknown): value is CoreRange["start"] {
  return (
    isRecord(value) &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line >= 0 &&
    typeof value.character === "number" &&
    Number.isInteger(value.character) &&
    value.character >= 0
  );
}
