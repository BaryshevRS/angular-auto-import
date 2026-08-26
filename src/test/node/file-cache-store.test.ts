import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CACHE_SCHEMA_VERSION, FileCacheStore } from "../../lsp/file-cache-store";

describe("LSP file cache store", function () {
  this.timeout(10000);

  const rootPath = path.resolve(path.sep, "workspace", "apps", "shop");
  let storage: string;

  beforeEach(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-cache-"));
  });

  afterEach(async () => {
    await fs.rm(storage, { recursive: true, force: true });
  });

  function openStore(overrides: { rootPath?: string; fingerprint?: Record<string, string> } = {}): FileCacheStore {
    return new FileCacheStore({
      directory: storage,
      rootPath: overrides.rootPath ?? rootPath,
      fingerprint: overrides.fingerprint ?? { angular: "22.0.0" },
    });
  }

  it("starts empty when nothing was ever written", async () => {
    const store = openStore();

    assert.strictEqual(await store.open(), false);
    assert.strictEqual(store.get("selectors"), undefined);
  });

  it("reads back what a previous session wrote", async () => {
    const first = openStore();
    await first.open();
    await first.set("selectors", { "app-card": { name: "CardComponent" } });
    await first.set("modules", ["CardModule"]);

    const second = openStore();

    assert.strictEqual(await second.open(), true);
    assert.deepStrictEqual(second.get("selectors"), { "app-card": { name: "CardComponent" } });
    assert.deepStrictEqual(second.get("modules"), ["CardModule"]);
  });

  it("forgets a deleted key in this session and the next", async () => {
    const first = openStore();
    await first.open();
    await first.set("selectors", { "app-card": 1 });
    await first.delete("selectors");
    assert.strictEqual(first.get("selectors"), undefined);

    const second = openStore();
    await second.open();

    assert.strictEqual(second.get("selectors"), undefined);
  });

  it("does not reuse a cache written for a different project state", async () => {
    const first = openStore();
    await first.open();
    await first.set("selectors", { "app-card": 1 });

    const upgraded = openStore({ fingerprint: { angular: "23.0.0" } });

    assert.strictEqual(await upgraded.open(), false, "An Angular upgrade must force a cold reindex");
    assert.strictEqual(upgraded.get("selectors"), undefined);
  });

  it("does not reuse a cache written by an older schema", async () => {
    const store = openStore();
    await store.open();
    await store.set("selectors", { "app-card": 1 });
    const stored = JSON.parse(await fs.readFile(store.location, "utf8"));
    await fs.writeFile(store.location, JSON.stringify({ ...stored, schemaVersion: CACHE_SCHEMA_VERSION - 1 }), "utf8");

    assert.strictEqual(await openStore().open(), false);
  });

  it("survives a corrupt cache file instead of failing to start", async () => {
    const store = openStore();
    await store.open();
    await store.set("selectors", { "app-card": 1 });
    await fs.writeFile(store.location, "{ not json", "utf8");

    const reopened = openStore();

    assert.strictEqual(await reopened.open(), false);
    await reopened.set("selectors", { "app-card": 2 });
    assert.deepStrictEqual(openStore().get("selectors"), undefined, "A fresh store reads only after open()");
  });

  it("keeps two project roots in separate files", async () => {
    const otherRoot = path.resolve(path.sep, "workspace", "apps", "admin");
    const shop = openStore();
    const admin = openStore({ rootPath: otherRoot });
    await shop.open();
    await admin.open();

    await shop.set("selectors", { "app-card": 1 });
    await admin.set("selectors", { "app-nav": 1 });

    assert.notStrictEqual(shop.location, admin.location);
    assert.deepStrictEqual(openStore().get("selectors"), undefined);
    const reopenedShop = openStore();
    await reopenedShop.open();
    assert.deepStrictEqual(reopenedShop.get("selectors"), { "app-card": 1 });
  });

  it("applies concurrent writes in order and leaves no temporary file behind", async () => {
    const store = openStore();
    await store.open();

    await Promise.all([store.set("a", 1), store.set("b", 2), store.set("a", 3)]);

    const reopened = openStore();
    await reopened.open();
    assert.strictEqual(reopened.get("a"), 3);
    assert.strictEqual(reopened.get("b"), 2);
    assert.deepStrictEqual(
      (await fs.readdir(storage)).filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  it("clears every entry", async () => {
    const store = openStore();
    await store.open();
    await store.set("selectors", { "app-card": 1 });

    await store.clear();

    const reopened = openStore();
    assert.strictEqual(await reopened.open(), true);
    assert.strictEqual(reopened.get("selectors"), undefined);
  });
});
