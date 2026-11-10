// Small in-memory fixed-window rate limiter. GroupBoard is a single process, so a Map is
// enough; counters reset when the server restarts.
function createLimiter({ max, windowMs }) {
  const entries = new Map(); // key -> { count, resetAt }

  function current(key) {
    const entry = entries.get(key);
    if (entry && Date.now() >= entry.resetAt) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  // Drop expired entries now and then so the Map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) if (now >= entry.resetAt) entries.delete(key);
  }, 60 * 1000);
  sweep.unref();

  return {
    // Seconds until `key` may try again, or 0 if it isn't blocked.
    retryAfter(key) {
      const entry = current(key);
      if (!entry || entry.count < max) return 0;
      return Math.ceil((entry.resetAt - Date.now()) / 1000);
    },
    hit(key) {
      const entry = current(key);
      if (!entry) {
        entries.set(key, { count: 1, resetAt: Date.now() + windowMs });
        return;
      }
      entry.count += 1;
      // The hit that reaches the limit starts a full window from now, so a lockout always
      // lasts `windowMs` (otherwise failures spread across a window could lock for seconds).
      if (entry.count === max) entry.resetAt = Date.now() + windowMs;
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

module.exports = { createLimiter };
