import * as assert from "node:assert";
import * as path from "node:path";
import { getRelativeFilePath, isPathInside, normalizePath, switchFileType } from "../../utils/path";

const root = path.resolve("/project");
const at = (...segments: string[]) => path.join(root, ...segments);

describe("Path utilities", () => {
  describe("getRelativeFilePath", () => {
    const host = at("src", "app", "host.component.ts");

    it("starts a sibling with ./", () => {
      assert.strictEqual(getRelativeFilePath(host, at("src", "app", "card")), "./card");
    });

    it("walks up with ../", () => {
      assert.strictEqual(getRelativeFilePath(host, at("src", "shared", "card")), "../shared/card");
    });

    it("keeps ./ before a child directory whose name starts with a dot", () => {
      // Without it the specifier is a package name, and the import does not resolve.
      assert.strictEqual(getRelativeFilePath(host, at("src", "app", ".generated", "api")), "./.generated/api");
    });

    it("writes forward slashes whatever the platform", () => {
      assert.ok(!getRelativeFilePath(host, at("src", "shared", "card")).includes("\\"));
    });
  });

  describe("switchFileType", () => {
    it("removes the extension", () => {
      assert.strictEqual(switchFileType(at("src", "card.component.ts"), ""), at("src", "card.component"));
    });

    it("replaces the extension", () => {
      assert.strictEqual(switchFileType(at("src", "card.component.html"), ".ts"), at("src", "card.component.ts"));
    });
  });

  describe("isPathInside", () => {
    it("counts the root itself and its descendants", () => {
      assert.strictEqual(isPathInside(root, root), true);
      assert.strictEqual(isPathInside(root, at("src", "app")), true);
    });

    it("refuses the parent and a sibling that shares the root's name as a prefix", () => {
      assert.strictEqual(isPathInside(root, path.dirname(root)), false);
      assert.strictEqual(isPathInside(root, path.resolve("/project-other", "src")), false);
    });

    it("counts a child directory whose name starts with two dots", () => {
      assert.strictEqual(isPathInside(root, at("..cache", "file")), true);
    });
  });

  it("normalizes backslashes to forward slashes", () => {
    assert.strictEqual(normalizePath("C:\\project\\src\\app"), "C:/project/src/app");
  });
});
