export function createInMemoryRateLimiter({ maxBuckets = 10000, clock = Date.now } = {}) {
  const buckets = new Map();
  const capacity = Math.max(1, Math.floor(Number(maxBuckets) || 10000));

  function prune(now, windowMs) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= windowMs) buckets.delete(key);
    }
  }

  return {
    allow(key, limit, windowMs) {
      const now = clock();
      const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
      const safeWindow = Math.max(1, Math.floor(Number(windowMs) || 1));
      const existing = buckets.get(key);
      if (existing && now - existing.start < safeWindow) {
        existing.count += 1;
        return existing.count <= safeLimit;
      }
      if (buckets.size >= capacity) prune(now, safeWindow);
      if (buckets.size >= capacity) return false;
      buckets.set(key, { start: now, count: 1 });
      return true;
    },
    get size() {
      return buckets.size;
    }
  };
}
