import * as assert from "node:assert";
import { renderMissingImportAuditHtml } from "../../commands/report-webview";
import type { DiagnosticsReport } from "../../lsp/protocol";

function report(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    scope: "project",
    projectsScanned: 1,
    templatesScanned: 1,
    complete: true,
    incompleteReasons: [],
    totalIssues: 0,
    timestamp: "2026-08-27T00:00:00.000Z",
    files: [],
    ...overrides,
  };
}

function fixAllButtons(html: string): string[] {
  return html.match(/<button\b[^>]*\bdata-action=["']fix-all["'][^>]*>[\s\S]*?<\/button>/gi) ?? [];
}

function enabledFixAllButtons(html: string): string[] {
  return fixAllButtons(html).filter((button) => !/\sdisabled(?:\s|=|>)/i.test(button));
}

function skeletons(html: string): string[] {
  return html.match(/<[^>]+\bclass=["'][^"']*\bskeleton(?:\b|-)[^"']*["'][^>]*>/gi) ?? [];
}

function enabledInteractiveButtons(html: string): string[] {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) ?? [];
  return buttons
    .filter((button) => /\b(?:data-action|data-location)=/i.test(button))
    .filter((button) => !/\sdisabled(?:\s|=|>)/i.test(button));
}

describe("Missing import audit webview", () => {
  it("does not claim a clean result when the scan is incomplete", () => {
    const report = {
      scope: "project",
      projectsScanned: 1,
      templatesScanned: 0,
      complete: false,
      incompleteReasons: ["analysis-not-ready"],
      totalIssues: 0,
      timestamp: "2026-08-27T00:00:00.000Z",
      files: [],
    } as Parameters<typeof renderMissingImportAuditHtml>[0];

    const html = renderMissingImportAuditHtml(report, {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
    });

    assert.match(html, /Scan did not complete/i);
    assert.doesNotMatch(html, /No missing imports found/i);
  });

  it("renders an accessible finding button that posts its exact location", () => {
    const filePath = "/workspace/src/host.html";
    const range = {
      start: { line: 3, character: 4 },
      end: { line: 3, character: 13 },
    };
    const report = {
      scope: "project",
      projectsScanned: 1,
      templatesScanned: 1,
      complete: true,
      incompleteReasons: [],
      totalIssues: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      files: [
        {
          filePath,
          templateType: "external",
          diagnostics: [
            {
              severity: "warning",
              message: "Missing import",
              code: "missing-component-import:shop-card",
              range,
            },
          ],
        },
      ],
    } as Parameters<typeof renderMissingImportAuditHtml>[0];

    const html = renderMissingImportAuditHtml(report, {
      nonce: "test-nonce",
      relativePath: () => "src/host.html",
    });

    const button = html.match(/<button\b[^>]*\bdata-location="([^"]+)"[^>]*>[\s\S]*?<\/button>/i);
    assert.ok(button, "Expected the finding to render as a native button");
    assert.match(button[0], /\btype="button"/i);
    assert.match(
      button[0],
      /\baria-label="Open warning Missing import \(missing-component-import:shop-card\) in src\/host\.html at line 4, column 5"/i
    );

    const encodedLocation = button[1]
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    assert.deepStrictEqual(JSON.parse(encodedLocation), { filePath, range });

    assert.match(html, /script-src[^>]*'nonce-test-nonce'/i);
    assert.match(html, /<script\b[^>]*\bnonce="test-nonce"[^>]*>/i);
    assert.doesNotMatch(html, /\sonclick\s*=/i);
    assert.match(html, /addEventListener\(\s*["']click["']/);
    assert.match(html, /JSON\.parse\(/);
    assert.match(html, /vscode\.postMessage\(/);
    assert.match(html, /type\s*:\s*["']openLocation["']/);
  });

  it("offers one accessible direct project-wide Fix All for every finding in a complete report", () => {
    const html = renderMissingImportAuditHtml(
      report({
        templatesScanned: 2,
        totalIssues: 3,
        files: [
          {
            filePath: "/workspace/src/host.html",
            templateType: "external",
            diagnostics: [
              {
                severity: "warning",
                message: "Missing shop card import",
                code: "missing-component-import:shop-card",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
              },
              {
                severity: "warning",
                message: "Missing shop badge import",
                code: "missing-component-import:shop-badge",
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
              },
            ],
          },
          {
            filePath: "/workspace/src/details.ts",
            templateType: "inline",
            diagnostics: [
              {
                severity: "warning",
                message: "Missing shop price import",
                code: "missing-component-import:shop-price",
                range: { start: { line: 5, character: 12 }, end: { line: 5, character: 22 } },
              },
            ],
          },
        ],
      }),
      { nonce: "test-nonce", relativePath: (filePath) => filePath.replace("/workspace/", "") }
    );

    const buttons = enabledFixAllButtons(html);
    assert.strictEqual(buttons.length, 1, "A complete report must have one enabled bulk action, not one per file");
    assert.match(buttons[0], /\btype=["']button["']/i);
    assert.match(buttons[0], /\bclass=["'][^"']*\bfix-all\b[^"']*["']/i);
    assert.match(buttons[0], /\baria-label=["']Fix all 3 findings project-wide["']/i);
    assert.strictEqual(buttons[0].replace(/<[^>]+>/g, "").trim(), "Fix All (3 findings)");
    assert.match(html, /vscode\.postMessage\(\s*{\s*type\s*:\s*["']fixAll["']\s*}\s*\)/);
    assert.doesNotMatch(html, /\b(?:window\.)?confirm\s*\(/i);
  });

  it("labels a 50-finding Fix All honestly without calling findings imports", () => {
    const html = renderMissingImportAuditHtml(report({ totalIssues: 50 }), {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
    });

    const buttons = enabledFixAllButtons(html);
    assert.strictEqual(buttons.length, 1);
    assert.match(buttons[0], /\baria-label=["']Fix all 50 findings project-wide["']/i);
    assert.strictEqual(buttons[0].replace(/<[^>]+>/g, "").trim(), "Fix All (50 findings)");
    assert.doesNotMatch(buttons[0], /\bimports?\b/i);
  });

  it("renders a separate accessible Refresh button that posts the exact refresh message", () => {
    const html = renderMissingImportAuditHtml(report({ totalIssues: 1 }), {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
    });

    const refreshButtons = html.match(/<button\b[^>]*\bdata-action=["']refresh["'][^>]*>[\s\S]*?<\/button>/gi) ?? [];
    assert.strictEqual(refreshButtons.length, 1, "Expected a dedicated Refresh button");
    assert.match(refreshButtons[0], /\btype=["']button["']/i);
    assert.strictEqual(refreshButtons[0].replace(/<[^>]+>/g, "").trim(), "Refresh");
    assert.doesNotMatch(refreshButtons[0], /\bdata-action=["']fix-all["']/i);
    assert.match(html, /vscode\.postMessage\(\s*{\s*type\s*:\s*["']refresh["']\s*}\s*\)/);
  });

  it("renders skeletons instead of an interactive result during the initial load", () => {
    const html = renderMissingImportAuditHtml(report(), {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
      loading: true,
    } as Parameters<typeof renderMissingImportAuditHtml>[1] & { loading: true });

    assert.match(html, /\baria-busy=["']true["']/i);
    assert.ok(skeletons(html).length >= 3, "Expected multiple skeleton placeholders during the initial load");
    assert.deepStrictEqual(enabledInteractiveButtons(html), []);
    assert.doesNotMatch(html, /No missing imports found/i);
  });

  it("replaces stale findings and actions with skeletons while refreshing", () => {
    const staleFilePath = "/workspace/src/stale-host.html";
    const html = renderMissingImportAuditHtml(
      report({
        totalIssues: 1,
        files: [
          {
            filePath: staleFilePath,
            templateType: "external",
            diagnostics: [
              {
                severity: "warning",
                message: "Stale missing import finding",
                code: "missing-component-import:stale-card",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
              },
            ],
          },
        ],
      }),
      {
        nonce: "test-nonce",
        relativePath: (filePath) => filePath,
        loading: true,
      } as Parameters<typeof renderMissingImportAuditHtml>[1] & { loading: true }
    );

    assert.match(html, /\baria-busy=["']true["']/i);
    assert.ok(skeletons(html).length >= 3, "Expected multiple skeleton placeholders while refreshing");
    assert.deepStrictEqual(enabledInteractiveButtons(html), []);
    assert.doesNotMatch(html, /Stale missing import finding/i);
    assert.doesNotMatch(html, /stale-host\.html/i);
  });

  it("never enables project-wide Fix All for incomplete or empty reports", () => {
    const incomplete = renderMissingImportAuditHtml(
      report({ complete: false, incompleteReasons: ["cancelled"], totalIssues: 3 }),
      { nonce: "test-nonce", relativePath: (filePath) => filePath }
    );
    const empty = renderMissingImportAuditHtml(report(), {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
    });

    assert.deepStrictEqual(enabledFixAllButtons(incomplete), []);
    assert.deepStrictEqual(enabledFixAllButtons(empty), []);
  });

  it("keeps file headings compact and visually prominent", () => {
    const html = renderMissingImportAuditHtml(report(), {
      nonce: "test-nonce",
      relativePath: (filePath) => filePath,
    });
    const rule = html.match(/\.file-path\s*{([^}]*)}/i);

    assert.ok(rule, "Expected an explicit .file-path style rule");
    assert.match(rule[1], /(?:^|;)\s*font-size\s*:\s*1em\s*(?:;|$)/i);
    assert.match(rule[1], /(?:^|;)\s*line-height\s*:\s*1\.3\s*(?:;|$)/i);
    assert.match(rule[1], /(?:^|;)\s*font-weight\s*:\s*600\s*(?:;|$)/i);
  });
});
