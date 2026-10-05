import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { RunStore } from "./run-store.js";
import type { RunQuote } from "./steps.js";

const databaseUrl = process.env.RUN_STORE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("the run store against Postgres", () => {
  let prisma: PrismaClient;
  let store: RunStore;
  let accountId: string;
  let apiCreditsId: string;

  const quote: RunQuote = { lines: [{ action: "intent:mint", units: 2, unitCredits: 5, credits: 10 }], total: 10 };
  const progress = { files: {}, uploadUrls: {}, tokenUris: {}, batches: {} };

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    store = (await import("./run-store.js")).prismaRunStore;
    const account = await prisma.account.create({
      data: { publicId: `run-store-${Date.now()}`, apiCredits: { create: { creditBalance: 100 } } },
      select: { id: true, apiCredits: { select: { id: true } } },
    });
    accountId = account.id;
    apiCreditsId = account.apiCredits!.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  async function paidRun() {
    const run = await store.create({ apiCreditsId, service: "data-tokenization-erc721", spec: {} });
    expect(await store.checkout({ id: run.id, apiCreditsId, service: run.service, quote, progress, path: "/test" })).toBe("paid");
    return run;
  }

  const read = (id: string) => store.get(id, apiCreditsId);

  test("checkout holds the quote, debits it once and records its usage", async () => {
    const before = await store.balance(apiCreditsId);
    const run = await paidRun();
    expect(await store.balance(apiCreditsId)).toBe(before - quote.total);
    expect((await read(run.id))!.creditsHeld).toBe(quote.total);
    expect(await store.checkout({ id: run.id, apiCreditsId, service: run.service, quote, progress, path: "/test" })).toBe("not-draft");
    expect(await store.balance(apiCreditsId)).toBe(before - quote.total);
    const usage = await prisma.usageEvent.count({ where: { apiCreditsId, path: "/test" } });
    expect(usage).toBeGreaterThan(0);
  });

  test("a checkout that cannot be afforded leaves the draft and the balance untouched", async () => {
    const before = await store.balance(apiCreditsId);
    const run = await store.create({ apiCreditsId, service: "data-tokenization-erc721", spec: {} });
    const expensive: RunQuote = { lines: [], total: before + 1 };
    expect(await store.checkout({ id: run.id, apiCreditsId, service: run.service, quote: expensive, progress, path: "/test" })).toBe("insufficient");
    expect((await read(run.id))!.status).toBe("DRAFT");
    expect(await store.balance(apiCreditsId)).toBe(before);
  });

  test("a step reserves once, never beyond the hold, and records what it produced", async () => {
    const run = await paidRun();
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 4, path: ["files", "a.pdf"] })).toBe(true);
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 4, path: ["files", "a.pdf"] })).toBe(false);
    expect(((await read(run.id))!.progress as { files: Record<string, unknown> }).files["a.pdf"]).toMatchObject({ status: "PENDING", credits: 4 });
    expect(typeof ((await read(run.id))!.progress as { files: Record<string, { at: string }> }).files["a.pdf"]!.at).toBe("string");

    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 7, path: ["files", "b.pdf"] })).toBe(false);

    await store.record(run.id, apiCreditsId, ["files", "a.pdf"], "ipfs://a");
    const recorded = (await read(run.id))!;
    expect((recorded.progress as { files: Record<string, unknown> }).files["a.pdf"]).toBe("ipfs://a");
    expect(recorded.status).toBe("RUNNING");
    expect(recorded.creditsSpent).toBe(4);

    await store.release({ id: run.id, apiCreditsId, credits: 4, path: ["files", "a.pdf"] });
    const released = (await read(run.id))!;
    expect(released.creditsSpent).toBe(0);
    expect((released.progress as { files: Record<string, unknown> }).files["a.pdf"]).toBeUndefined();
  });

  test("only a reverted transaction can be reserved again", async () => {
    const run = await paidRun();
    const path = ["batches", "0"];
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 2, path, retryReverted: true })).toBe(true);
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 2, path, retryReverted: true })).toBe(false);

    await store.record(run.id, apiCreditsId, path, { txHash: "0x1", status: "SUBMITTED" });
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 2, path, retryReverted: true })).toBe(false);

    await store.record(run.id, apiCreditsId, path, { txHash: "0x1", status: "REVERTED" });
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 2, path })).toBe(false);
    expect(await store.reserve({ id: run.id, apiCreditsId, credits: 2, path, retryReverted: true })).toBe(true);
  });

  test("completing refunds the unspent hold once, as a negative usage line", async () => {
    const run = await paidRun();
    await store.reserve({ id: run.id, apiCreditsId, credits: 3, path: ["tokenUris", "0"] });
    const before = await store.balance(apiCreditsId);

    expect(await store.complete({ id: run.id, apiCreditsId, status: "COMPLETED", path: "/complete" })).toEqual({ refunded: 7 });
    expect(await store.balance(apiCreditsId)).toBe(before + 7);
    expect((await read(run.id))!.status).toBe("COMPLETED");
    const refund = await prisma.usageEvent.findFirst({ where: { apiCreditsId, path: "/complete", actionKey: "launchpad:refund" } });
    expect(refund?.credits).toBe(-7);

    expect(await store.complete({ id: run.id, apiCreditsId, status: "COMPLETED", path: "/complete" })).toBeNull();
    expect(await store.balance(apiCreditsId)).toBe(before + 7);
  });

  describe("a step that was reserved and then abandoned", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test("is released with its credits once it is older than the limit", async () => {
      const run = await paidRun();
      const path = ["tokenUris", "0"];
      await store.reserve({ id: run.id, apiCreditsId, credits: 4, path });
      await wait(5);

      expect(await store.sweepStale({ id: run.id, apiCreditsId, paths: [path], olderThanMs: 0 })).toBe(1);
      const swept = (await read(run.id))!;
      expect(swept.creditsSpent).toBe(0);
      expect((swept.progress as { tokenUris: Record<string, unknown> }).tokenUris["0"]).toBeUndefined();
      expect(await store.reserve({ id: run.id, apiCreditsId, credits: 4, path })).toBe(true);
    });

    test("is left alone while it is still fresh", async () => {
      const run = await paidRun();
      const path = ["tokenUris", "0"];
      await store.reserve({ id: run.id, apiCreditsId, credits: 4, path });

      expect(await store.sweepStale({ id: run.id, apiCreditsId, paths: [path], olderThanMs: 60_000 })).toBe(0);
      expect((await read(run.id))!.creditsSpent).toBe(4);
    });

    test("is never released once it reached the chain", async () => {
      const run = await paidRun();
      const path = ["batches", "0"];
      await store.reserve({ id: run.id, apiCreditsId, credits: 4, path });
      await store.record(run.id, apiCreditsId, path, { txHash: "0x1", status: "SUBMITTED" });
      await wait(5);

      expect(await store.sweepStale({ id: run.id, apiCreditsId, paths: [path], olderThanMs: 0 })).toBe(0);
      expect((await read(run.id))!.creditsSpent).toBe(4);
    });

    test("is released once, however often the sweep runs", async () => {
      const run = await paidRun();
      const path = ["tokenUris", "0"];
      await store.reserve({ id: run.id, apiCreditsId, credits: 4, path });
      await wait(5);

      const results = await Promise.all([
        store.sweepStale({ id: run.id, apiCreditsId, paths: [path], olderThanMs: 0 }),
        store.sweepStale({ id: run.id, apiCreditsId, paths: [path], olderThanMs: 0 }),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect((await read(run.id))!.creditsSpent).toBe(0);
    });
  });
});
