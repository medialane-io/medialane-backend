import { describe, expect, test } from "bun:test";
import { createBoundedCache } from "./boundedCache.js";

const counting = <V>(value: V) => {
  let calls = 0;
  return { loader: async () => { calls++; return value; }, calls: () => calls };
};

describe("a bounded cache loads each key once", () => {
  test("a stored value is returned without loading again", async () => {
    const cache = createBoundedCache<string>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v.length });
    const source = counting("abc");
    expect(await cache.load("k", source.loader)).toBe("abc");
    expect(await cache.load("k", source.loader)).toBe("abc");
    expect(source.calls()).toBe(1);
  });

  test("concurrent loads of one key share a single load", async () => {
    const cache = createBoundedCache<string>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v.length });
    const source = counting("abc");
    const results = await Promise.all([cache.load("k", source.loader), cache.load("k", source.loader), cache.load("k", source.loader)]);
    expect(results).toEqual(["abc", "abc", "abc"]);
    expect(source.calls()).toBe(1);
  });

  test("a null answer is kept like any other value", async () => {
    const cache = createBoundedCache<string | null>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v?.length ?? 0 });
    const source = counting<string | null>(null);
    await cache.load("k", source.loader);
    await cache.load("k", source.loader);
    expect(source.calls()).toBe(1);
  });

  test("a failed load is not kept and the next load tries again", async () => {
    const cache = createBoundedCache<string>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v.length });
    let calls = 0;
    const flaky = async () => { calls++; if (calls === 1) throw new Error("rpc down"); return "ok"; };
    await expect(cache.load("k", flaky)).rejects.toThrow("rpc down");
    expect(await cache.load("k", flaky)).toBe("ok");
    expect(calls).toBe(2);
  });

  test("an expired value is loaded again", async () => {
    let clock = 0;
    const cache = createBoundedCache<string>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v.length, now: () => clock });
    const source = counting("abc");
    await cache.load("k", source.loader);
    clock = 1001;
    await cache.load("k", source.loader);
    expect(source.calls()).toBe(2);
  });

  test("the least recently used values are dropped to stay within the size", async () => {
    const cache = createBoundedCache<string>({ maxSize: 6, ttlMs: 1000, sizeOf: (v) => v.length });
    const a = counting("aaa");
    const b = counting("bbb");
    const c = counting("ccc");
    await cache.load("a", a.loader);
    await cache.load("b", b.loader);
    await cache.load("a", a.loader);
    await cache.load("c", c.loader);
    await cache.load("a", a.loader);
    await cache.load("b", b.loader);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  test("a value larger than the whole cache is returned but not kept", async () => {
    const cache = createBoundedCache<string>({ maxSize: 2, ttlMs: 1000, sizeOf: (v) => v.length });
    const source = counting("abc");
    expect(await cache.load("k", source.loader)).toBe("abc");
    await cache.load("k", source.loader);
    expect(source.calls()).toBe(2);
  });
});
