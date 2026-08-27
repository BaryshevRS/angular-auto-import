import * as assert from "node:assert";
import { formatAuditCompletionMessage } from "../../commands/audit-message";
import type { DiagnosticsReport } from "../../lsp/protocol";

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
