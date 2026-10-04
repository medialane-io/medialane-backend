import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { normalizeAddress } from "../../utils/starknet.js";

const OWNER = normalizeAddress("STARKNET", "0xa11ce");
const OTHER = normalizeAddress("STARKNET", "0xbad");
const COIN = normalizeAddress("STARKNET", "0xc0111");

describe("verifiedCreator", () => {
  test("a wallet that is the coin's on-chain owner is accepted", async () => {
    const { verifiedCreator } = await import("./coins.js");
    expect(await verifiedCreator("STARKNET", COIN, OWNER, async () => OWNER)).toBe(OWNER);
  });

  test("a wallet that is not the owner is ignored", async () => {
    const { verifiedCreator } = await import("./coins.js");
    expect(await verifiedCreator("STARKNET", COIN, OTHER, async () => OWNER)).toBeNull();
  });

  test("no owner given, an unreadable owner, a zero owner and a malformed address all give no creator", async () => {
    const { verifiedCreator } = await import("./coins.js");
    expect(await verifiedCreator("STARKNET", COIN, undefined, async () => OWNER)).toBeNull();
    expect(await verifiedCreator("STARKNET", COIN, OWNER, async () => { throw new Error("rpc"); })).toBeNull();
    expect(await verifiedCreator("STARKNET", COIN, OWNER, async () => normalizeAddress("STARKNET", "0x0"))).toBeNull();
    expect(await verifiedCreator("STARKNET", COIN, "not-an-address", async () => OWNER)).toBeNull();
  });
});

describe("GET /claims", () => {
  async function app(rows: unknown[]) {
    const findMany = mock((_args: { select: Record<string, boolean> }) => Promise.resolve(rows));
    mock.module("../../db/client.js", () => ({ default: { collectionClaim: { findMany } } }));
    const { default: coins } = await import("./coins.js");
    const a = new Hono<AppEnv>();
    a.route("/", coins);
    return { a, findMany };
  }

  test("only non-sensitive claim fields are selected", async () => {
    const { a, findMany } = await app([]);
    expect((await a.request("/claims?chain=STARKNET")).status).toBe(200);
    const args = findMany.mock.calls[0]![0];
    for (const field of ["claimantEmail", "notes", "adminNotes", "reviewedBy", "reviewedAt"]) {
      expect(args.select[field]).toBeUndefined();
    }
    expect(args.select.contractAddress).toBe(true);
    expect(args.select.status).toBe(true);
  });

  test("an unknown status is a 400, not a database error", async () => {
    const { a } = await app([]);
    expect((await a.request("/claims?chain=STARKNET&status=BOGUS")).status).toBe(400);
  });
});
