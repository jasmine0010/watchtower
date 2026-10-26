export const REQUEST_CACHE_MS = 5 * 60 * 1000;
export function requestCache<T>(limit: number) {
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + REQUEST_CACHE_MS });
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}
