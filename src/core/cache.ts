/** Persistence boundary shared by the Extension Host and language server runtimes. */
export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Keeps entries for this session only.
 *
 * The fallback for a host that offered nowhere to persist: the index is still built
 * and served, it just has to be rebuilt next time.
 */
export function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, unknown>();

  return {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}
