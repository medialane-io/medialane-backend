import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator");

export interface Loop {
  name: string;
  intervalMs: number;
  bootDelayMs?: number;
  tick: () => Promise<unknown>;
}

function sleepUnlessAborted(signal?: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
}

export async function runEvery(
  loop: Loop,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { signal } = opts;
  const sleep = opts.sleep ?? sleepUnlessAborted(signal);
  log.info({ loop: loop.name, intervalMs: loop.intervalMs }, "Loop started");

  if (loop.bootDelayMs) await sleep(loop.bootDelayMs);
  while (!signal?.aborted) {
    try {
      await loop.tick();
    } catch (err) {
      log.error({ err, loop: loop.name }, "Loop tick failed");
    }
    if (signal?.aborted) return;
    await sleep(loop.intervalMs);
  }
}
