import * as assert from "node:assert";
import { decodeAuditFixAllMessage, decodeAuditLocationMessage } from "../../commands/report-navigation";

describe("Missing import audit navigation", () => {
  it("decodes only well-formed absolute openLocation messages", () => {
    const message = {
      type: "openLocation",
      filePath: "/workspace/src/host.html",
      range: {
        start: { line: 3, character: 4 },
        end: { line: 3, character: 13 },
      },
    };

    assert.deepStrictEqual(decodeAuditLocationMessage(message), {
      filePath: "/workspace/src/host.html",
      range: message.range,
    });

    const malformed: unknown[] = [
      { ...message, type: "close" },
      { ...message, filePath: "   " },
      { ...message, filePath: "src/host.html" },
      { ...message, range: { ...message.range, start: { line: -1, character: 4 } } },
      { ...message, range: { ...message.range, end: { line: 3, character: 13.5 } } },
      { ...message, range: { start: { line: 4, character: 0 }, end: { line: 3, character: 13 } } },
      { ...message, range: { start: { line: 3, character: 14 }, end: { line: 3, character: 13 } } },
    ];
    for (const candidate of malformed) {
      assert.strictEqual(decodeAuditLocationMessage(candidate), undefined);
    }
  });

  it("decodes only the exact project-wide Fix All message", () => {
    assert.deepStrictEqual(decodeAuditFixAllMessage({ type: "fixAll" }), { type: "fixAll" });

    const malformed: unknown[] = [
      undefined,
      null,
      "fixAll",
      ["fixAll"],
      {},
      { type: "fix-all" },
      { type: "fixAll", transactionId: "from-the-webview" },
      { type: "fixAll", filePath: "/workspace/src/host.html" },
    ];
    for (const candidate of malformed) {
      assert.strictEqual(decodeAuditFixAllMessage(candidate), undefined);
    }
  });
});
