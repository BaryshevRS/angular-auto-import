import * as assert from "node:assert";
import { CompletionItemKind, DiagnosticSeverity } from "vscode-languageserver/node";
import { toLspCompletionKind, toLspDiagnostic, toLspDiagnosticSeverity } from "../../adapters/lsp/language-types";
import type { CoreCompletionKind, CoreDiagnosticSeverity } from "../../core/language-types";

describe("LSP language-type mappings", () => {
  it("maps every completion kind the analysis emits", () => {
    const kinds: Record<CoreCompletionKind, CompletionItemKind> = {
      class: CompletionItemKind.Class,
      function: CompletionItemKind.Function,
      keyword: CompletionItemKind.Keyword,
      property: CompletionItemKind.Property,
    };

    for (const [core, expected] of Object.entries(kinds)) {
      assert.strictEqual(toLspCompletionKind(core as CoreCompletionKind), expected, core);
    }
  });

  it("maps every severity the analysis emits", () => {
    const severities: Record<CoreDiagnosticSeverity, DiagnosticSeverity> = {
      error: DiagnosticSeverity.Error,
      warning: DiagnosticSeverity.Warning,
      information: DiagnosticSeverity.Information,
      hint: DiagnosticSeverity.Hint,
    };

    for (const [core, expected] of Object.entries(severities)) {
      assert.strictEqual(toLspDiagnosticSeverity(core as CoreDiagnosticSeverity), expected, core);
    }
  });

  it("carries a diagnostic across without losing what the quick fix needs", () => {
    const range = { start: { line: 3, character: 2 }, end: { line: 3, character: 12 } };

    const mapped = toLspDiagnostic({
      range,
      message: "'app-card' is part of a known component, but it is not imported.",
      code: "missing-component-import:app-card",
      source: "angular-auto-import",
      severity: "warning",
    });

    assert.deepStrictEqual(mapped, {
      range,
      message: "'app-card' is part of a known component, but it is not imported.",
      // The code is what the code action reads the selector back out of.
      code: "missing-component-import:app-card",
      source: "angular-auto-import",
      severity: DiagnosticSeverity.Warning,
    });
  });
});
