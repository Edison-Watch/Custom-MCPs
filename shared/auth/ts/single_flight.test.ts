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
    const results = await Promise.all(Array.from({ length: 8 }, () => flight.do("k", 0, start)));
    expect(results).toEqual(Array(8).fill("jwks"));
    expect(starts).toBe(1);
  });

  test("a rejected join is a miss: the joiner runs its own job instead of throwing", async () => {
    // Models Workers rejecting an await on another (ended) request's promise.
    const flight = new SingleFlight<string>(MAX_AGE);
    const dead = deferred<string>();
    const starter = flight.do("k", 0, () => dead.promise);
    const joiner = flight.do("k", 0, () => Promise.resolve("fresh"));
    dead.reject(new Error("This promise was created by a request that has since ended"));
    await expect(starter).rejects.toThrow();
    expect(await joiner).toBe("fresh");
  });

  test("a burst that all saw one dead entry converges on ONE replacement job", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    const dead = deferred<string>();
    void flight.do("k", 0, () => dead.promise).catch(() => {});
    let replacements = 0;
    const replace = () => {
      replacements++;
      return new Promise<string>((r) => setTimeout(() => r("fresh"), 5));
    };
    const joiners = Array.from({ length: 8 }, () => flight.do("k", 0, replace));
    dead.reject(new Error("cross-request"));
    expect(await Promise.all(joiners)).toEqual(Array(8).fill("fresh"));
    expect(replacements).toBe(1);
  });

  test("a join on a never-settling entry gives up when the entry expires", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    void flight.do("k", 0, () => new Promise<string>(() => {})); // orphaned starter
    const t0 = performance.now();
    const result = await flight.do("k", 0, () => Promise.resolve("fresh"));
    expect(result).toBe("fresh");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(MAX_AGE - 5);
  });

  test("an entry older than maxAge is not joined at all", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    void flight.do("k", 0, () => new Promise<string>(() => {}));
    const t0 = performance.now();
    expect(await flight.do("k", MAX_AGE + 1, () => Promise.resolve("fresh"))).toBe("fresh");
    expect(performance.now() - t0).toBeLessThan(MAX_AGE);
  });

  test("start may decline (cooldown), yielding MISS", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    expect(await flight.do("k", 0, () => undefined)).toBe(MISS);
  });

  test("an entry for another key is never joined", async () => {
    const flight = new SingleFlight<string>(MAX_AGE);
    const other = deferred<string>();
    void flight.do("a", 0, () => other.promise);
    expect(await flight.do("b", 0, () => Promise.resolve("b-result"))).toBe("b-result");
    other.resolve("a-result");
  });
});
