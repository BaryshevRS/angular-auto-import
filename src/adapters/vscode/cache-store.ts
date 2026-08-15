import type * as vscode from "vscode";
import type { CacheStore } from "../../core/cache";

/** Adapts VS Code workspace storage to the editor-agnostic cache boundary. */
export function createVsCodeCacheStore(memento: vscode.Memento): CacheStore {
  return {
    get: <T>(key: string) => memento.get<T>(key),
    set: async <T>(key: string, value: T) => {
      await memento.update(key, value);
    },
    delete: async (key: string) => {
      await memento.update(key, undefined);
    },
  };
}
