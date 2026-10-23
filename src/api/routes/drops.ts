import { validated } from "../http/validate.js";
import { Hono } from "hono";
import type { Chain, Drop, DropMint, Prisma } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import { callerApp } from "../../utils/caller.js";
import { dropFeeBps } from "../../orchestrator/intent/fee.js";
import { pageQuery } from "@medialane/sdk/contract";
import { chainScope } from "../http/chain.js";
import { DEFAULT_CHAIN } from "../../config/chains.js";

export type DropListStatus = "live" | "upcoming" | "ended";

/** `maxSupply` is the column reference compared against `minted` (sold out). */
export function buildDropListWhere(
  q: { status?: string; organizer?: string; now: number; chain?: Chain },
  maxSupply: Prisma.FieldRef<"Drop", "Decimal"> = prisma.drop.fields.maxSupply,
): Prisma.DropWhereInput {
  const { now, chain = DEFAULT_CHAIN } = q;
  const where: Prisma.DropWhereInput = { chain, collection: { isHidden: false, deletedAt: null } };
  if (q.organizer) where.organizer = normalizeAddress(chain, q.organizer);
  if (q.status === "live") {
    where.AND = [
      { OR: [{ startTime: 0 }, { startTime: { lte: now } }] },
      { OR: [{ endTime: 0 }, { endTime: { gte: now } }] },
      { OR: [{ maxSupply: 0 }, { minted: { lt: maxSupply } }] },
    ];
  } else if (q.status === "upcoming") {
    where.startTime = { gt: now };
  } else if (q.status === "ended") {
    where.OR = [{ endTime: { gt: 0, lt: now } }, { maxSupply: { gt: 0 }, minted: { gte: maxSupply } }];
  }
  return where;
}

type DropWithCollection = Drop & {
  collection: { name: string | null; symbol: string | null; description: string | null; image: string | null; baseUri: string | null };
};

const collectionFields = { select: { name: true, symbol: true, description: true, image: true, baseUri: true } } as const;

export function serializeDrop(d: DropWithCollection) {
  return {
    contractAddress: d.collectionAddress,
    dropId: d.dropId,
    organizer: d.organizer,
    name: d.collection.name,
    symbol: d.collection.symbol,
    description: d.collection.description,
    image: d.collection.image,
    baseUri: d.collection.baseUri,
    maxSupply: d.maxSupply.toFixed(),
    minted: d.minted.toFixed(),
    revenue: d.revenue.toFixed(),
    collectors: d.collectors,
    terms: {
      startTime: d.startTime.toNumber(),
      endTime: d.endTime.toNumber(),
      price: d.price.toFixed(),
      paymentToken: d.paymentToken,
      maxPerWallet: d.maxPerWallet.toFixed(),
    },
    allowlistRoot: d.allowlistRoot,
    createdBlock: d.createdBlock.toString(),
  };
}

export function serializeDropMint(m: DropMint) {
  return {
    kind: m.kind === "CLAIM" ? "claim" : "issue",
    wallet: m.wallet,
    quantity: m.quantity.toFixed(),
    firstTokenId: m.firstTokenId.toFixed(),
    totalPaid: m.totalPaid.toFixed(),
    txHash: m.txHash,
    blockNumber: m.blockNumber.toString(),
    createdAt: m.createdAt.toISOString(),
  };
}

const contractParam = (chain: Chain, raw: string): string | null => {
  try {
    return normalizeAddress(chain, raw);
  } catch {
    return null;
  }
};

const drops = new Hono<AppEnv>();

drops.get("/", chainScope(), validated("query", pageQuery({ defaultLimit: 24 })), async (c) => {
  const chain = c.get("chain");
  const { page, limit } = c.req.valid("query");
  const status = c.req.query("status");
  const organizerRaw = c.req.query("organizer");
  const organizer = organizerRaw ? contractParam(chain, organizerRaw) : undefined;
  if (organizerRaw && !organizer) return c.json({ error: "Invalid organizer address" }, 400);
  const where = buildDropListWhere({ status, organizer: organizer ?? undefined, now: Math.floor(Date.now() / 1000), chain });
  const orderBy: Prisma.DropOrderByWithRelationInput = status === "upcoming" ? { startTime: "asc" } : { createdBlock: "desc" };
  const [rows, total] = await Promise.all([
    prisma.drop.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: { collection: collectionFields } }),
    prisma.drop.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeDrop), meta: { page, limit, total } });
});

drops.get("/fee", (c) => c.json({ data: { launchpadBps: dropFeeBps(callerApp(c)) } }));

drops.get("/:contract", chainScope(), async (c) => {
  const chain = c.get("chain");
  const collectionAddress = contractParam(chain, c.req.param("contract"));
  if (!collectionAddress) return c.json({ error: "Invalid contract address" }, 400);
  const row = await prisma.drop.findFirst({
    where: { chain, collectionAddress, collection: { isHidden: false, deletedAt: null } },
    include: { collection: collectionFields },
  });
  if (!row) return c.json({ error: "Drop not found" }, 404);
  return c.json({ data: serializeDrop(row) });
});

drops.get("/:contract/mints", chainScope(), validated("query", pageQuery({ defaultLimit: 24 })), async (c) => {
  const chain = c.get("chain");
  const collectionAddress = contractParam(chain, c.req.param("contract"));
  if (!collectionAddress) return c.json({ error: "Invalid contract address" }, 400);
  const { page, limit } = c.req.valid("query");
  const where = { chain, collectionAddress };
  const [rows, total] = await Promise.all([
    prisma.dropMint.findMany({ where, orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }], skip: (page - 1) * limit, take: limit }),
    prisma.dropMint.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeDropMint), meta: { page, limit, total } });
});

export default drops;
