const MAX_ENTRIES = 500;

export class TtlCache<T> {
  private store = new Map<string, { value: T; expires: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.delete(key);
    while (this.store.size >= MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}
