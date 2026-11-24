/**
 * Best-effort single-flight for Cloudflare Workers: coalesce concurrent
 * requests in one isolate onto one outstanding async job (e.g. a JWKS GET).
 *
 * Why "best-effort": the shared promise belongs to the request that started
 * the job. Workers refuses to settle it inside any other request once that one
 * has ended (handle_cross_request_promise_resolution, on by default for
 * compatibility dates from 2024-10-14), so a joiner's await rejects with "This
 * promise was created by a request that has since ended". If the starter is
 * cancelled mid-job its cleanup never runs either, leaving the slot pointing at
 * a dead promise for the isolate's lifetime. So in {@link SingleFlight.do}:
 *   - a join that rejects is a miss, never surfaced to the caller;
 *   - a join is bounded by the entry's remaining life (`maxAgeMs` from its
 *     start), so no caller waits on an older entry even if the runtime leaves
 *     the await pending instead of rejecting it;
 *   - after a miss the caller re-checks the slot and, if it is free, starts the
 *     replacement synchronously (no await in between), so a burst that saw one
 *     dead entry converges on ONE replacement job instead of one each.
 * The timer racing a join is created by the joiner, in its own request, so it
 * is always safe to await.
 */

/** Returned by {@link SingleFlight.do} when nothing was joined or started. */
export const MISS: unique symbol = Symbol("single-flight-miss");

interface Entry<T> {
  key: string;
  promise: Promise<T>;
  startedAt: number;
}

export class SingleFlight<T> {
  private entry: Entry<T> | null = null;

  /** @param maxAgeMs how long an entry can be live; older ones are orphans. */
  constructor(private readonly maxAgeMs: number) {}

  /**
   * Join the live job for `key`, or else call `start()` and make its promise
   * the outstanding job. `start` returns undefined to decline (e.g. a
   * cooldown), which yields {@link MISS}; it is called synchronously.
   */
  async do(key: string, now: number, start: () => Promise<T> | undefined): Promise<T | typeof MISS> {
    const failed = new Set<Entry<T>>();
    for (;;) {
      const cur = this.entry;
      if (cur && cur.key === key && !failed.has(cur)) {
        const remaining = this.maxAgeMs - (now - cur.startedAt);
        if (remaining > 0) {
          const result = await raceTimeout(cur.promise, remaining);
          if (result !== MISS) return result;
        }
        failed.add(cur);
        if (this.entry === cur) this.entry = null;
        continue; // re-check: another caller may already have replaced it
      }

      const promise = start();
      if (!promise) return MISS;
      const entry: Entry<T> = { key, promise, startedAt: now };
      this.entry = entry;
      try {
        return await promise;
      } finally {
        if (this.entry === entry) this.entry = null;
      }
    }
  }

  /** Drop any outstanding entry. Test-only. */
  reset(): void {
    this.entry = null;
  }
}

/** `promise`'s value, or MISS if it rejects or has not settled within `ms`. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof MISS> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof MISS>((resolve) => {
    timer = setTimeout(() => resolve(MISS), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } catch {
    return MISS;
  } finally {
    clearTimeout(timer);
  }
}
