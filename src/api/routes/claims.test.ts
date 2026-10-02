import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import * as realStarknet from "../../utils/starknet.js";

const CONTRACT = realStarknet.normalizeAddress("STARKNET", "0xc0de");
const OWNER = realStarknet.normalizeAddress("STARKNET", "0xa11ce");
const OTHER = realStarknet.normalizeAddress("STARKNET", "0xbad");

async function setup(opts: { owner: string | Error; signatureValid?: boolean; wallet: string }) {
  const challengeRecord = {
    challenge: "ch1",
    contractAddress: CONTRACT,
    walletAddress: opts.wallet,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const db = {
    claimChallenge: {
      findUnique: mock(() => Promise.resolve(challengeRecord)),
      delete: mock(() => Promise.resolve({})),
      deleteMany: mock(() => Promise.resolve({ count: 0 })),
    },
    collection: {
      findUnique: mock(() => Promise.resolve({ startBlock: 1n })),
      update: mock(() => Promise.resolve({ startBlock: 1n, claimedBy: opts.wallet })),
    },
    collectionClaim: { create: mock(() => Promise.resolve({})) },
  };
  mock.module("../../db/client.js", () => ({ default: db }));
  mock.module("../../utils/starknet.js", () => ({
    ...realStarknet,
    callRpc: mock(() => Promise.resolve(opts.signatureValid ?? true)),
  }));
  mock.module("../../chainRead/index.js", () => ({
    getCollectionOwner: mock(() =>
      opts.owner instanceof Error ? Promise.reject(opts.owner) : Promise.resolve(opts.owner),
    ),
  }));
  mock.module("../../orchestrator/worker.js", () => ({ worker: { enqueue: mock(() => {}) } }));

  const { default: claims } = await import("./claims.js");
  const app = new Hono<AppEnv>();
  app.route("/", claims);
  const verify = () =>
    app.request("/verify?chain=STARKNET", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractAddress: CONTRACT,
        walletAddress: opts.wallet,
        challenge: "ch1",
        signature: { r: "0x1", s: "0x2" },
      }),
    });
  return { db, verify };
}

describe("POST /verify", () => {
  test("a wallet that signs but does not own the collection is refused", async () => {
    const { db, verify } = await setup({ owner: OWNER, wallet: OTHER });
    const body = (await (await verify()).json()) as { verified: boolean; reason?: string };
    expect(body).toEqual({ verified: false, reason: "owner_mismatch" });
    expect(db.collection.update).not.toHaveBeenCalled();
    expect(db.collectionClaim.create).not.toHaveBeenCalled();
    expect(db.claimChallenge.delete).not.toHaveBeenCalled();
  });

  test("the on-chain owner who signs is verified", async () => {
    const { db, verify } = await setup({ owner: OWNER, wallet: OWNER });
    const body = (await (await verify()).json()) as { verified: boolean };
    expect(body.verified).toBe(true);
    expect(db.collection.update).toHaveBeenCalledTimes(1);
    expect(db.collectionClaim.create).toHaveBeenCalledTimes(1);
  });

  test("an owner that cannot be read refuses the claim", async () => {
    const { db, verify } = await setup({ owner: new Error("rpc down"), wallet: OWNER });
    const body = (await (await verify()).json()) as { verified: boolean; reason?: string };
    expect(body).toEqual({ verified: false, reason: "owner_check_failed" });
    expect(db.collection.update).not.toHaveBeenCalled();
  });

  test("a zero owner never verifies", async () => {
    const { db, verify } = await setup({ owner: realStarknet.normalizeAddress("STARKNET", "0x0"), wallet: OWNER });
    const body = (await (await verify()).json()) as { verified: boolean };
    expect(body.verified).toBe(false);
    expect(db.collection.update).not.toHaveBeenCalled();
  });

  test("an invalid signature is refused before the owner is read", async () => {
    const { db, verify } = await setup({ owner: OWNER, wallet: OWNER, signatureValid: false });
    const body = (await (await verify()).json()) as { reason?: string };
    expect(body.reason).toBe("invalid_signature");
    expect(db.collection.update).not.toHaveBeenCalled();
  });
});
