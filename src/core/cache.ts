/** Persistence boundary shared by the Extension Host and language server runtimes. */
export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
