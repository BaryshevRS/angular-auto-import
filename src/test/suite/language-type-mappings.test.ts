import * as assert from "node:assert";
import * as vscode from "vscode";
import { CompletionItemKind } from "vscode-languageserver/node";
import { toLspCompletionKind } from "../../adapters/lsp/language-types";
import {
  fromVsCodeRange,
  toVsCodeCompletionKind,
  toVsCodeDiagnosticSeverity,
  toVsCodeRange,
} from "../../adapters/vscode/language-types";
import type { CoreCompletionKind, CoreDiagnosticSeverity, CoreRange } from "../../core/language-types";

describe("language type mappings", () => {
  const range: CoreRange = {
    start: { line: 2, character: 3 },
    end: { line: 4, character: 5 },
  };

  it("maps ranges explicitly at the active VS Code boundary", () => {
    const vscodeRange = toVsCodeRange(range);

    assert.ok(vscodeRange instanceof vscode.Range);
    assert.deepStrictEqual(fromVsCodeRange(vscodeRange), range);
  });

  it("maps every core completion kind to VS Code and LSP enums", () => {
    const expected: Array<[CoreCompletionKind, vscode.CompletionItemKind, CompletionItemKind]> = [
      ["class", vscode.CompletionItemKind.Class, CompletionItemKind.Class],
      ["function", vscode.CompletionItemKind.Function, CompletionItemKind.Function],
      ["keyword", vscode.CompletionItemKind.Keyword, CompletionItemKind.Keyword],
      ["property", vscode.CompletionItemKind.Property, CompletionItemKind.Property],
    ];

    for (const [kind, vscodeKind, lspKind] of expected) {
      assert.strictEqual(toVsCodeCompletionKind(kind), vscodeKind);
      assert.strictEqual(toLspCompletionKind(kind), lspKind);
    }
  });

  it("maps every core diagnostic severity at the active VS Code boundary", () => {
    const expected: Array<[CoreDiagnosticSeverity, vscode.DiagnosticSeverity]> = [
      ["error", vscode.DiagnosticSeverity.Error],
      ["warning", vscode.DiagnosticSeverity.Warning],
      ["information", vscode.DiagnosticSeverity.Information],
      ["hint", vscode.DiagnosticSeverity.Hint],
    ];

    for (const [severity, vscodeSeverity] of expected) {
      assert.strictEqual(toVsCodeDiagnosticSeverity(severity), vscodeSeverity);
    }
  });
});
