import * as assert from "node:assert";
import { renderMissingImportAuditHtml } from "../../commands/report-webview";

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
});
