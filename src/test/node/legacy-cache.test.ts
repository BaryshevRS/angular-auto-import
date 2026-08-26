import * as assert from "node:assert";
import { silentLogger } from "../../core/logging";
import { removeLegacyCache, type WorkspaceState } from "../../legacy-cache";

/** The keys the previous implementation wrote for one project: a prefix and a hash. */
function legacyKeys(projectHash: string): Record<string, unknown> {
  return Object.fromEntries(
    ["angularFileCache_", "angularSelectorToDataIndex_", "angularModulesCache_", "angularExternalModulesExports_"].map(
      (prefix) => [`${prefix}${projectHash}`, {}]
    )
  );
}

/** Workspace state a test can inspect, standing in for VS Code's memento. */
function workspaceState(entries: Record<string, unknown>, options: { failOnUpdate?: boolean } = {}) {
  const stored = new Map(Object.entries(entries));
  const state: WorkspaceState = {
    keys: () => [...stored.keys()],
    update: (key, value) => {
      if (options.failOnUpdate) {
        return Promise.reject(new Error("workspace state is read-only"));
      }
      if (value === undefined) {
        stored.delete(key);
      }
      return Promise.resolve();
    },
  };
  return { state, stored };
}

describe("Clearing the previous index cache", () => {
  it("removes every entry the previous implementation wrote", async () => {
    const { state, stored } = workspaceState(legacyKeys("abc123"));

    const removed = await removeLegacyCache(state, silentLogger);

    assert.strictEqual(removed, 4);
    assert.deepStrictEqual([...stored.keys()], []);
  });

  it("removes the entries of every project a workspace held", async () => {
    const { state, stored } = workspaceState({ ...legacyKeys("shop"), ...legacyKeys("admin") });

    assert.strictEqual(await removeLegacyCache(state, silentLogger), 8);
    assert.deepStrictEqual([...stored.keys()], []);
  });

  it("leaves anything it did not write alone", async () => {
    const { state, stored } = workspaceState({
      ...legacyKeys("abc123"),
      "some.other.extension.state": { keep: true },
      angularSomethingElse: { keep: true },
    });

    await removeLegacyCache(state, silentLogger);

    assert.deepStrictEqual([...stored.keys()].sort(), ["angularSomethingElse", "some.other.extension.state"]);
  });

  it("does nothing, quietly, in a workspace that has none", async () => {
    const { state } = workspaceState({ "some.other.extension.state": {} });

    assert.strictEqual(await removeLegacyCache(state, silentLogger), 0);
  });

  it("survives storage it cannot write, rather than failing activation", async () => {
    const { state, stored } = workspaceState(legacyKeys("abc123"), { failOnUpdate: true });

    const removed = await removeLegacyCache(state, silentLogger);

    assert.strictEqual(removed, 0);
    assert.strictEqual(stored.size, 4, "The entries are simply left where they are");
  });
});
