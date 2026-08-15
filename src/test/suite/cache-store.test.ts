import * as assert from "node:assert";
import type * as vscode from "vscode";
import { createVsCodeCacheStore } from "../../adapters/vscode/cache-store";

describe("VS Code cache store", () => {
  let values: Map<string, unknown>;
  let memento: vscode.Memento;

  beforeEach(() => {
    values = new Map<string, unknown>();
    memento = {
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        (values.has(key) ? values.get(key) : defaultValue) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) {
          values.delete(key);
          return;
        }
        values.set(key, value);
      },
      keys: () => [...values.keys()],
    };
  });

  it("reads values from workspace storage", () => {
    values.set("index", { selectors: 3 });
    const store = createVsCodeCacheStore(memento);

    assert.deepStrictEqual(store.get("index"), { selectors: 3 });
  });

  it("writes values to workspace storage", async () => {
    const store = createVsCodeCacheStore(memento);

    await store.set("index", { selectors: 5 });

    assert.deepStrictEqual(values.get("index"), { selectors: 5 });
  });

  it("deletes values from workspace storage", async () => {
    values.set("index", { selectors: 1 });
    const store = createVsCodeCacheStore(memento);

    await store.delete("index");

    assert.strictEqual(values.has("index"), false);
  });
});
