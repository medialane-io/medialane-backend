import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { RunStore } from "./run-store.js";
import type { RunQuote } from "./steps.js";

const databaseUrl = process.env.RUN_STORE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("the run store against Postgres", () => {
  let prisma: PrismaClient;
  let store: RunStore;
  let accountId: string;
  let apiClientId: string;

  const quote: RunQuote = { lines: [{ action: "intent:mint", units: 2, unitCredits: 5, credits: 10 }], total: 10 };
  const progress = { files: {}, uploadUrls: {}, tokenUris: {}, batches: {} };

  beforeAll(async () => {
    prisma = (await import("../db/client.js")).default;
    store = (await import("./run-store.js")).prismaRunStore;
    const account = await prisma.account.create({
      data: { publicId: `run-store-${Date.now()}`, apiClient: { create: { creditBalance: 100 } } },
      select: { id: true, apiClient: { select: { id: true } } },
    });
    accountId = account.id;
    apiClientId = account.apiClient!.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  async function paidRun() {
    const run = await store.create({ apiClientId, service: "data-tokenization-erc721", spec: {} });
    expect(await store.checkout({ id: run.id, apiClientId, service: run.service, quote, progress, path: "/test" })).toBe("paid");
    return run;
  }

  const read = (id: string) => store.get(id, apiClientId);

  test("checkout holds the quote, debits it once and records its usage", async () => {
    const before = await store.balance(apiClientId);
    const run = await paidRun();
    expect(await store.balance(apiClientId)).toBe(before - quote.total);
    expect((await read(run.id))!.creditsHeld).toBe(quote.total);
    expect(await store.checkout({ id: run.id, apiClientId, service: run.service, quote, progress, path: "/test" })).toBe("not-draft");
    expect(await store.balance(apiClientId)).toBe(before - quote.total);
    const usage = await prisma.usageEvent.count({ where: { apiClientId, path: "/test" } });
    expect(usage).toBeGreaterThan(0);
  });

  test("a checkout that cannot be afforded leaves the draft and the balance untouched", async () => {
    const before = await store.balance(apiClientId);
    const run = await store.create({ apiClientId, service: "data-tokenization-erc721", spec: {} });
    const expensive: RunQuote = { lines: [], total: before + 1 };
    expect(await store.checkout({ id: run.id, apiClientId, service: run.service, quote: expensive, progress, path: "/test" })).toBe("insufficient");
    expect((await read(run.id))!.status).toBe("DRAFT");
    expect(await store.balance(apiClientId)).toBe(before);
  });

  test("a step reserves once, never beyond the hold, and records what it produced", async () => {
    const run = await paidRun();
    expect(await store.reserve({ id: run.id, apiClientId, credits: 4, path: ["files", "a.pdf"] })).toBe(true);
    expect(await store.reserve({ id: run.id, apiClientId, credits: 4, path: ["files", "a.pdf"] })).toBe(false);
    expect(((await read(run.id))!.progress as { files: Record<string, unknown> }).files["a.pdf"]).toEqual({ status: "PENDING" });

    expect(await store.reserve({ id: run.id, apiClientId, credits: 7, path: ["files", "b.pdf"] })).toBe(false);

    await store.record(run.id, apiClientId, ["files", "a.pdf"], "ipfs://a");
    const recorded = (await read(run.id))!;
    expect((recorded.progress as { files: Record<string, unknown> }).files["a.pdf"]).toBe("ipfs://a");
    expect(recorded.status).toBe("RUNNING");
    expect(recorded.creditsSpent).toBe(4);

    await store.release({ id: run.id, apiClientId, credits: 4, path: ["files", "a.pdf"] });
    const released = (await read(run.id))!;
    expect(released.creditsSpent).toBe(0);
    expect((released.progress as { files: Record<string, unknown> }).files["a.pdf"]).toBeUndefined();
  });

  test("only a reverted transaction can be reserved again", async () => {
    const run = await paidRun();
    const path = ["batches", "0"];
    expect(await store.reserve({ id: run.id, apiClientId, credits: 2, path, retryReverted: true })).toBe(true);
    expect(await store.reserve({ id: run.id, apiClientId, credits: 2, path, retryReverted: true })).toBe(false);

    await store.record(run.id, apiClientId, path, { txHash: "0x1", status: "SUBMITTED" });
    expect(await store.reserve({ id: run.id, apiClientId, credits: 2, path, retryReverted: true })).toBe(false);

    await store.record(run.id, apiClientId, path, { txHash: "0x1", status: "REVERTED" });
    expect(await store.reserve({ id: run.id, apiClientId, credits: 2, path })).toBe(false);
    expect(await store.reserve({ id: run.id, apiClientId, credits: 2, path, retryReverted: true })).toBe(true);
  });

  test("completing refunds the unspent hold once, as a negative usage line", async () => {
    const run = await paidRun();
    await store.reserve({ id: run.id, apiClientId, credits: 3, path: ["tokenUris", "0"] });
    const before = await store.balance(apiClientId);

    expect(await store.complete({ id: run.id, apiClientId, status: "COMPLETED", path: "/complete" })).toEqual({ refunded: 7 });
    expect(await store.balance(apiClientId)).toBe(before + 7);
    expect((await read(run.id))!.status).toBe("COMPLETED");
    const refund = await prisma.usageEvent.findFirst({ where: { apiClientId, path: "/complete", actionKey: "launchpad:refund" } });
    expect(refund?.credits).toBe(-7);

    expect(await store.complete({ id: run.id, apiClientId, status: "COMPLETED", path: "/complete" })).toBeNull();
    expect(await store.balance(apiClientId)).toBe(before + 7);
  });
});
