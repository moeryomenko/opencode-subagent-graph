/** In-memory storage used by tests and as the reference StorageLike shape. */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  scan(options: { prefix: string }): Promise<Array<{ key: string; value: unknown }>>;
}

export class MemoryStorage implements StorageLike {
  private readonly entries = new Map<string, unknown>();

  async get(key: string) {
    return this.entries.get(key);
  }

  async set(key: string, value: unknown) {
    this.entries.set(key, value);
  }

  async remove(key: string) {
    this.entries.delete(key);
  }

  async scan(options: { prefix: string }) {
    return [...this.entries]
      .filter(([key]) => key.startsWith(options.prefix))
      .map(([key, value]) => ({ key, value }));
  }

  clear() {
    this.entries.clear();
  }
}
