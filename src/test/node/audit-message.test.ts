import * as assert from "node:assert";
import {
  formatAuditCompletionMessage,
  formatFixAllConfirmationMessage,
  formatFixAllResultMessage,
} from "../../commands/audit-message";
import type { AppliedWorkspaceFixAll, DiagnosticsReport, PreparedWorkspaceFixAll } from "../../lsp/protocol";

describe("Missing import audit completion message", () => {
  it("describes an unfinished report as incomplete, never complete", () => {
    const report: DiagnosticsReport = {
      scope: "workspace",
      projectsScanned: 2,
      templatesScanned: 7,
      complete: false,
      incompleteReasons: ["cancelled"],
      totalIssues: 3,
      timestamp: "2026-08-27T00:00:00.000Z",
      files: [],
    };

    const message = formatAuditCompletionMessage(report);

    assert.strictEqual(message, "Missing import audit incomplete: 3 issue(s) across 7 scanned template(s).");
    assert.doesNotMatch(message, /\bcomplete\b/i);
  });
});

describe("Project-wide Fix All messages", () => {
  const prepared: PreparedWorkspaceFixAll = {
    ready: true,
    transactionId: "prepared-1",
    totalIssues: 7,
    filesChanged: 2,
    importsAdded: 3,
  };

  it("confirms the exact prepared import and file counts, not the diagnostic count", () => {
    assert.strictEqual(formatFixAllConfirmationMessage(prepared), "Apply 3 missing imports across 2 files?");
  });

  it("reports the exact counts that were applied", () => {
    const applied: AppliedWorkspaceFixAll = {
      applied: true,
      totalIssues: 7,
      filesChanged: 2,
      importsAdded: 3,
    };

    assert.strictEqual(formatFixAllResultMessage(applied), "Applied 3 missing imports across 2 files.");
  });

  it("distinguishes stale, rejected, and unfixable outcomes", () => {
    const stale: AppliedWorkspaceFixAll = { ...prepared, applied: false, reason: "stale" };
    const rejected: AppliedWorkspaceFixAll = { ...prepared, applied: false, reason: "rejected" };
    const unfixable: PreparedWorkspaceFixAll = { ready: false, reason: "unfixable" };

    const staleMessage = formatFixAllResultMessage(stale);
    const rejectedMessage = formatFixAllResultMessage(rejected);
    const unfixableMessage = formatFixAllResultMessage(unfixable);

    assert.match(staleMessage, /stale/i);
    assert.match(staleMessage, /run the audit again/i);
    assert.match(rejectedMessage, /rejected/i);
    assert.match(unfixableMessage, /could not be fixed safely/i);
    assert.strictEqual(new Set([staleMessage, rejectedMessage, unfixableMessage]).size, 3);
  });
});
