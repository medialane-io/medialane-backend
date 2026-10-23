import { describe, expect, test } from "bun:test";
import { runEvery, type Loop } from "./schedule.js";

function harness(stopAfterSleeps: number) {
  const ac = new AbortController();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    if (sleeps.length >= stopAfterSleeps) ac.abort();
  };
  return { ac, sleeps, opts: { signal: ac.signal, sleep } };
}

const loop = (tick: () => Promise<unknown>, extra: Partial<Loop> = {}): Loop => ({
  name: "test",
  intervalMs: 10,
  tick,
  ...extra,
});

describe("runEvery", () => {
  test("waits the boot delay, then ticks, then waits the interval between ticks", async () => {
    const h = harness(3);
    let ticks = 0;
    await runEvery(loop(async () => void ticks++, { bootDelayMs: 5 }), h.opts);
    expect(h.sleeps).toEqual([5, 10, 10]);
    expect(ticks).toBe(2);
  });

  test("without a boot delay the first tick runs before any wait", async () => {
    const h = harness(1);
    let ticks = 0;
    await runEvery(loop(async () => void ticks++), h.opts);
    expect(ticks).toBe(1);
    expect(h.sleeps).toEqual([10]);
  });

  test("a tick that throws is logged and the next tick still runs", async () => {
    const h = harness(2);
    let ticks = 0;
    await runEvery(
      loop(async () => {
        ticks++;
        if (ticks === 1) throw new Error("boom");
      }),
      h.opts,
    );
    expect(ticks).toBe(2);
  });

  test("a signal already aborted runs nothing", async () => {
    const h = harness(99);
    h.ac.abort();
    let ticks = 0;
    await runEvery(loop(async () => void ticks++, { bootDelayMs: 5 }), h.opts);
    expect(ticks).toBe(0);
  });

  test("aborting during the default wait ends the loop without waiting out the interval", async () => {
    const ac = new AbortController();
    let ticks = 0;
    const started = Date.now();
    const done = runEvery({ name: "test", intervalMs: 60_000, tick: async () => void ticks++ }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await done;
    expect(ticks).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
