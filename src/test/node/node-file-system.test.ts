import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../../adapters/node/file-system";

const fileSystem = createNodeFileSystem();

async function writeFile(filePath: string, content = "export class Test {}\n"): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("Node file system", function () {
  this.timeout(10000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-fs-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  /** Returns the found paths relative to the sandbox, sorted, for readable assertions. */
  async function find(query: Partial<Parameters<typeof fileSystem.findFiles>[0]> = {}): Promise<string[]> {
    const found = await fileSystem.findFiles({ root: sandbox, extensions: [".ts"], ...query });
    return found.map((filePath) => path.relative(sandbox, filePath).split(path.sep).join("/")).sort();
  }

  it("finds files of the requested extensions at any depth", async () => {
    await writeFile(path.join(sandbox, "src", "app.component.ts"));
    await writeFile(path.join(sandbox, "src", "pages", "home", "home.component.ts"));
    await writeFile(path.join(sandbox, "src", "app.component.html"), "<div></div>");

    assert.deepStrictEqual(await find(), ["src/app.component.ts", "src/pages/home/home.component.ts"]);
    assert.deepStrictEqual(await find({ extensions: [".ts", ".html"] }), [
      "src/app.component.html",
      "src/app.component.ts",
      "src/pages/home/home.component.ts",
    ]);
  });

  it("returns absolute paths", async () => {
    await writeFile(path.join(sandbox, "src", "app.component.ts"));

    const found = await fileSystem.findFiles({ root: sandbox, extensions: [".ts"] });

    assert.ok(found.every((filePath) => path.isAbsolute(filePath)));
  });

  it("never enters an excluded directory", async () => {
    await writeFile(path.join(sandbox, "src", "app.component.ts"));
    await writeFile(path.join(sandbox, "node_modules", "lib", "index.ts"));
    await writeFile(path.join(sandbox, "src", "nested", "node_modules", "lib", "index.ts"));
    await writeFile(path.join(sandbox, "dist", "main.ts"));

    assert.deepStrictEqual(await find({ excludedDirectories: ["node_modules", "dist"] }), ["src/app.component.ts"]);
  });

  it("skips hidden directories only when asked to", async () => {
    await writeFile(path.join(sandbox, "src", "app.component.ts"));
    await writeFile(path.join(sandbox, ".angular", "cache", "stale.ts"));

    assert.deepStrictEqual(await find({ excludeHiddenDirectories: true }), ["src/app.component.ts"]);
    assert.deepStrictEqual(await find(), [".angular/cache/stale.ts", "src/app.component.ts"]);
  });

  it("skips files with an excluded suffix", async () => {
    await writeFile(path.join(sandbox, "src", "app.component.ts"));
    await writeFile(path.join(sandbox, "src", "app.component.spec.ts"));
    await writeFile(path.join(sandbox, "src", "app.test.ts"));

    assert.deepStrictEqual(await find({ excludedSuffixes: [".spec.ts", ".test.ts"] }), ["src/app.component.ts"]);
  });

  it("returns nothing for a root that does not exist", async () => {
    assert.deepStrictEqual(
      await fileSystem.findFiles({ root: path.join(sandbox, "missing"), extensions: [".ts"] }),
      []
    );
  });

  it("reads a file as UTF-8 text and rejects for a missing one", async () => {
    const filePath = path.join(sandbox, "src", "app.component.ts");
    await writeFile(filePath, "// комментарий\n");

    assert.strictEqual(await fileSystem.readFile(filePath), "// комментарий\n");
    await assert.rejects(fileSystem.readFile(path.join(sandbox, "missing.ts")));
  });
});
