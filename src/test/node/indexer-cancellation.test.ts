import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../../adapters/node/file-system";
import { createMemoryCacheStore } from "../../core/cache";
import { createCancellationSource } from "../../core/cancellation";
import { silentLogger, withInstrumentation } from "../../core/logging";
import { silentProgressHost } from "../../core/progress";
import { AngularIndexer } from "../../services/indexer";

const inertWatchers = { watch: () => ({ dispose: () => undefined }) };

function createIndexer(): AngularIndexer {
  return new AngularIndexer({
    cacheStore: createMemoryCacheStore(),
    logger: withInstrumentation(silentLogger),
    fileSystem: createNodeFileSystem(),
    progressHost: silentProgressHost,
    fileWatchers: inertWatchers,
  });
}

async function writeComponents(root: string, count: number): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < count; index++) {
    await fs.writeFile(
      path.join(root, "src", `card-${index}.component.ts`),
      `import { Component } from "@angular/core";\n@Component({ selector: "card-${index}", standalone: true, template: "" })\nexport class Card${index}Component {}\n`,
      "utf8"
    );
  }
}

describe("Indexing cancellation", function () {
  this.timeout(20000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-cancel-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("indexes a project when nothing cancels it", async () => {
    await writeComponents(sandbox, 3);
    const indexer = createIndexer();
    indexer.setProjectRoot(sandbox);

    await indexer.generateFullIndex();

    assert.deepStrictEqual(indexer.getAllSelectors().sort(), ["card-0", "card-1", "card-2"]);
    indexer.dispose();
  });

  it("serves nothing from a scan that was cancelled before it started", async () => {
    await writeComponents(sandbox, 3);
    const indexer = createIndexer();
    indexer.setProjectRoot(sandbox);
    const cancellation = createCancellationSource();
    cancellation.cancel();

    const result = await indexer.generateFullIndex(undefined, cancellation.signal);

    assert.strictEqual(result.size, 0);
    assert.deepStrictEqual(indexer.getAllSelectors(), [], "A cancelled scan must not leave a partial index behind");
    indexer.dispose();
  });

  it("stops a scan cancelled while it runs and keeps the index empty", async () => {
    // More than one batch, so cancellation is observed between batches.
    await writeComponents(sandbox, 45);
    const indexer = createIndexer();
    indexer.setProjectRoot(sandbox);
    const cancellation = createCancellationSource();

    const indexing = indexer.generateFullIndex(undefined, cancellation.signal);
    cancellation.cancel();
    const result = await indexing;

    assert.strictEqual(result.size, 0);
    assert.deepStrictEqual(indexer.getAllSelectors(), []);
    indexer.dispose();
  });

  it("indexes normally again after a cancelled scan", async () => {
    await writeComponents(sandbox, 3);
    const indexer = createIndexer();
    indexer.setProjectRoot(sandbox);
    const cancellation = createCancellationSource();
    cancellation.cancel();
    await indexer.generateFullIndex(undefined, cancellation.signal);

    await indexer.generateFullIndex();

    assert.deepStrictEqual(indexer.getAllSelectors().sort(), ["card-0", "card-1", "card-2"]);
    indexer.dispose();
  });
});
