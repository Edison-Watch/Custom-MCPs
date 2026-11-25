import { describe, expect, test } from "bun:test";

import { MISS, SingleFlight } from "./single_flight";

const MAX_AGE = 50;

/** A promise plus handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlight", () => {
  test("concurrent callers for one key share a single job", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    let starts = 0;
    const start = () => {
      starts++;
      return new Promise<string>((r) => setTimeout(() => r("jwks"), 5));
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => flight.do("k", start)));
    expect(results).toEqual(Array(8).fill("jwks"));
    expect(starts).toBe(1);
  });

  test("a rejected join is a miss: the joiner runs its own job instead of throwing", async () => {
    // Models Workers rejecting an await on another (ended) request's promise.
    const flight = new SingleFlight<string>(MAX_AGE);
    const dead = deferred<string>();
    const starter = flight.do("k", () => dead.promise);
    const joiner = flight.do("k", () => Promise.resolve("fresh"));
    dead.reject(new Error("This promise was created by a request that has since ended"));
    await expect(starter).rejects.toThrow();
    expect(await joiner).toBe("fresh");
  });

  test("a burst that all saw one dead entry converges on ONE replacement job", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    const dead = deferred<string>();
    void flight.do("k", () => dead.promise).catch(() => {});
    let replacements = 0;
    const replace = () => {
      replacements++;
      return new Promise<string>((r) => setTimeout(() => r("fresh"), 5));
    };
    const joiners = Array.from({ length: 8 }, () => flight.do("k", replace));
    dead.reject(new Error("cross-request"));
    expect(await Promise.all(joiners)).toEqual(Array(8).fill("fresh"));
    expect(replacements).toBe(1);
  });

  test("a join on a never-settling entry gives up when the entry expires", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    void flight.do("k", () => new Promise<string>(() => {})); // orphaned starter
    const t0 = performance.now();
    const result = await flight.do("k", () => Promise.resolve("fresh"));
    expect(result).toBe("fresh");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(MAX_AGE - 5);
  });

  test("an entry older than maxAge is not joined at all", async () => {
    let t = 0;
    const flight = new SingleFlight<string>(MAX_AGE, () => t);
    void flight.do("k", () => new Promise<string>(() => {}));
    t = MAX_AGE + 1;
    const t0 = performance.now();
    expect(await flight.do("k", () => Promise.resolve("fresh"))).toBe("fresh");
    expect(performance.now() - t0).toBeLessThan(MAX_AGE);
  });

  test("a replacement started after a long wait is stamped with the fresh clock", async () => {
    // A joiner waits out an orphan's full life, then starts the replacement.
    // If that entry carried the joiner's original timestamp it would already
    // look expired, and the next caller would fetch again instead of joining.
    let t = 0;
    const flight = new SingleFlight<string>(MAX_AGE, () => t);
    void flight.do("k", () => new Promise<string>(() => {})); // orphan at t=0
    let starts = 0;
    const replacement = deferred<string>();
    const start = () => {
      starts++;
      return replacement.promise;
    };
    const joiner = flight.do("k", start); // joins the orphan at t=0
    t = MAX_AGE; // the wait takes the orphan's whole life
    await new Promise((r) => setTimeout(r, MAX_AGE + 20)); // joiner times out, starts replacement
    expect(starts).toBe(1);
    t = MAX_AGE + 1; // fresh replacement: must still be joinable
    const next = flight.do("k", start);
    replacement.resolve("fresh");
    expect(await Promise.all([joiner, next])).toEqual(["fresh", "fresh"]);
    expect(starts).toBe(1);
  });

  test("start may decline (cooldown), yielding MISS", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    expect(await flight.do("k", () => undefined)).toBe(MISS);
  });

  test("an entry for another key is never joined", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    const other = deferred<string>();
    void flight.do("a", () => other.promise);
    expect(await flight.do("b", () => Promise.resolve("b-result"))).toBe("b-result");
    other.resolve("a-result");
  });
});
