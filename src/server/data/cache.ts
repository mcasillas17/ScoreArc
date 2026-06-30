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
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}
