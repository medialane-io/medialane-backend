import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { normalizeAddress } from "@medialane/sdk";
import drops, { buildDropListWhere, serializeDrop, serializeDropMint } from "./drops.js";

const NOW = 1_800_000_000;
const D = (v: string | number) => new Prisma.Decimal(v);
const maxSupplyColumn = { modelName: "Drop", name: "maxSupply" } as never;

describe("buildDropListWhere", () => {
  const visible = { isHidden: false, deletedAt: null };
  test("live: started, not ended, not sold out", () => {
    expect(buildDropListWhere({ status: "live", now: NOW }, maxSupplyColumn)).toEqual({
      chain: "STARKNET",
      collection: visible,
      AND: [
        { OR: [{ startTime: 0 }, { startTime: { lte: NOW } }] },
        { OR: [{ endTime: 0 }, { endTime: { gte: NOW } }] },
        { OR: [{ maxSupply: 0 }, { minted: { lt: maxSupplyColumn } }] },
      ],
    });
  });
  test("upcoming: starts later", () => {
    expect(buildDropListWhere({ status: "upcoming", now: NOW }, maxSupplyColumn)).toEqual({ chain: "STARKNET", collection: visible, startTime: { gt: NOW } });
  });
  test("ended: past its end, or sold out", () => {
    expect(buildDropListWhere({ status: "ended", now: NOW }, maxSupplyColumn)).toEqual({
      chain: "STARKNET",
      collection: visible,
      OR: [{ endTime: { gt: 0, lt: NOW } }, { maxSupply: { gt: 0 }, minted: { gte: maxSupplyColumn } }],
    });
  });
  test("organizer filter is normalized; no status lists every drop", () => {
    expect(buildDropListWhere({ organizer: "0x222", now: NOW }, maxSupplyColumn)).toEqual({
      chain: "STARKNET",
      collection: visible,
      organizer: "0x0000000000000000000000000000000000000000000000000000000000000222",
    });
  });
});

describe("serializers", () => {
  const row = {
    chain: "STARKNET", collectionAddress: "0xd409", dropId: "7", organizer: "0x1",
    maxSupply: D("1e30"), startTime: D("18446744073709551615"), endTime: D(0), price: D("5000000"),
    paymentToken: "0xusdc", maxPerWallet: D(5), allowlistRoot: "0x0", allowlistRootBlock: 1n,
    minted: D(310), revenue: D("1550000000"), collectors: 120, createdBlock: 16240900n,
    createdAt: new Date(0), updatedAt: new Date(0),
    collection: { name: "Neon Tides", symbol: "NEON", description: "d", image: "ipfs://img", baseUri: "ipfs://cid/" },
  };

  test("a drop serializes amounts as plain decimal strings", () => {
    expect(serializeDrop(row as never)).toEqual({
      contractAddress: "0xd409", dropId: "7", organizer: "0x1",
      name: "Neon Tides", symbol: "NEON", description: "d", image: "ipfs://img", baseUri: "ipfs://cid/",
      maxSupply: "1000000000000000000000000000000", minted: "310", revenue: "1550000000", collectors: 120,
      terms: { startTime: 18446744073709551615, endTime: 0, price: "5000000", paymentToken: "0xusdc", maxPerWallet: "5" },
      allowlistRoot: "0x0", createdBlock: "16240900",
    });
  });

  test("a mint serializes its kind in lower case", () => {
    expect(serializeDropMint({
      id: "m", chain: "STARKNET", collectionAddress: "0xd409", kind: "ISSUE", wallet: "0x2",
      quantity: D(2), firstTokenId: D(1), totalPaid: D(0), blockNumber: 16240901n, txHash: "0xt", logIndex: 0, createdAt: new Date(0),
    } as never)).toEqual({
      kind: "issue", wallet: "0x2", quantity: "2", firstTokenId: "1", totalPaid: "0", txHash: "0xt", blockNumber: "16240901", createdAt: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("GET /v1/drops", () => {
  test("an unparsable organizer is a 400", async () => {
    const res = await drops.request("/?organizer=not-an-address");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/drops/fee", () => {
  test("returns the caller's launchpad fee in basis points", async () => {
    const res = await drops.request("/fee");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { launchpadBps: number } };
    expect(typeof body.data.launchpadBps).toBe("number");
  });
});

describe("buildDropListWhere organizer", () => {
  test("a non-canonical organizer is normalized", () => {
    const where = buildDropListWhere({ organizer: "0x0ABC", now: NOW }, maxSupplyColumn);
    expect(where.organizer).toBe(normalizeAddress("STARKNET", "0xabc"));
  });
});
