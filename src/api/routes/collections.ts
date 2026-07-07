import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { chainWhere, parseChainFilter } from "../utils/chainFilter.js";
import type { RawCollectionRow, RawCountRow, RawTokenRow } from "../utils/rawTypes.js";
import prisma from "../../db/client.js";
import { authMiddleware } from "../middleware/adminSecretAuth.js";
import { env } from "../../config/env.js";
import { serializeToken } from "../utils/serialize.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { num as starkNum } from "starknet";
import { STARKNET_COLLECTION_721_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../mirror/handlers/collectionCreated.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { callRpc } from "../../utils/starknet.js";
import { parseStandardFilter } from "./collections.standardFilter.js";

const log = createLogger("routes:collections");

const collections = new Hono();

type ResolvedCollectionForSync = {
  contractAddress: string;
  owner: string;
  name: string | null;
  symbol: string | null;
  baseUri: string | null;
  startBlock: bigint;
};

function decodeByteArray(felts: string[], offset: number): { value: string; nextOffset: number } {
  if (offset >= felts.length) return { value: "", nextOffset: offset };
  const dataLen = Number(BigInt(felts[offset]));
  if (felts.length < offset + 1 + dataLen + 2) return { value: "", nextOffset: felts.length };

  const pendingWord = BigInt(felts[offset + 1 + dataLen] ?? "0x0");
  const pendingWordLen = Number(BigInt(felts[offset + 1 + dataLen + 1] ?? "0"));
  const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
  let byteOffset = 0;

  for (let i = 0; i < dataLen; i++) {
    const value = BigInt(felts[offset + 1 + i]);
    for (let j = 0; j < 31; j++) {
      bytes[byteOffset++] = Number((value >> BigInt((30 - j) * 8)) & 0xffn);
    }
  }

  for (let j = 0; j < pendingWordLen; j++) {
    bytes[byteOffset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }

  return {
    value: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    nextOffset: offset + 1 + dataLen + 2,
  };
}

function safeNormalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeAddress("STARKNET", value);
  } catch {
    return null;
  }
}

function resolveCollectionFromReceipt(
  collectionEvent: any,
  allEvents: any[],
  registryAddress: string,
  owner: string,
  blockNumber: bigint
): ResolvedCollectionForSync | null {
  const dataFelts = ((collectionEvent.data ?? []) as string[]).map((d) => starkNum.toHex(d));
  if (dataFelts.length < 6) return null;

  const { value: name, nextOffset: afterName } = decodeByteArray(dataFelts, 3);
  const { value: symbol, nextOffset: afterSymbol } = decodeByteArray(dataFelts, afterName);
  const { value: baseUri } = decodeByteArray(dataFelts, afterSymbol);

  const deployedEvent = allEvents.find((event: any) => {
    const fromAddress = safeNormalizeAddress(event.from_address);
    if (!fromAddress || fromAddress === registryAddress) return false;
    const data = (event.data ?? []) as string[];
    return data.some((felt) => safeNormalizeAddress(felt) === registryAddress);
  });

  const contractAddress = safeNormalizeAddress(deployedEvent?.from_address);
  if (!contractAddress) return null;

  return {
    contractAddress,
    owner,
    name: name || null,
    symbol: symbol || null,
    baseUri: baseUri || null,
    startBlock: blockNumber,
  };
}

// Valid sort values for GET /v1/collections
const COLLECTION_SORT_VALUES = ["recent", "supply", "floor", "volume", "name"] as const;
type CollectionSort = (typeof COLLECTION_SORT_VALUES)[number];

const VALID_COLLECTION_STANDARDS = new Set(["ERC721", "ERC1155"]);

// GET /v1/collections
collections.get("/", async (c) => {
  const page  = Math.max(1, Number(c.req.query("page")  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const isFeatured   = c.req.query("isFeatured") ?? c.req.query("isKnown");
  const owner     = c.req.query("owner");
  const service   = c.req.query("service");
  const standardFilter = parseStandardFilter(c.req.query("standard"));
  const hideEmpty = c.req.query("hideEmpty") === "true";
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const sortRaw = c.req.query("sort") ?? "recent";
  const sort: CollectionSort = (COLLECTION_SORT_VALUES as readonly string[]).includes(sortRaw)
    ? (sortRaw as CollectionSort)
    : "recent";

  const skip = (page - 1) * limit;

  // floor and volume are String? columns — need ::numeric cast via raw SQL
  if (sort === "floor" || sort === "volume") {
    const conditions: Prisma.Sql[] = [Prisma.sql`"isHidden" = false`];
    if (chainFilter !== "all") conditions.push(Prisma.sql`chain = ${chainFilter.chain}::"Chain"`);
    if (isFeatured === "true")  conditions.push(Prisma.sql`"isFeatured" = true`);
    if (isFeatured === "false") conditions.push(Prisma.sql`"isFeatured" = false`);
    if (owner)     conditions.push(Prisma.sql`owner = ${normalizeAddress("STARKNET", owner)}`);
    if (service)   conditions.push(Prisma.sql`service = ${service}`);
    if (standardFilter) {
      // $queryRaw sends params as text; TokenStandard is an enum — cast each value
      // explicitly or Postgres errors "operator does not exist: TokenStandard = text".
      const casted = standardFilter.map((s) => Prisma.sql`${s}::"TokenStandard"`);
      conditions.push(Prisma.sql`standard IN (${Prisma.join(casted)})`);
    }
    if (hideEmpty) conditions.push(Prisma.sql`"totalSupply" > 0`);
    const whereClause = Prisma.join(conditions, " AND ");

    const orderExpr = sort === "floor"
      ? Prisma.sql`"floorPrice"::numeric ASC NULLS LAST`
      : Prisma.sql`"totalVolume"::numeric DESC NULLS LAST`;

    const [data, rawTotal] = await Promise.all([
      prisma.$queryRaw<RawCollectionRow[]>`
        SELECT * FROM "Collection"
        WHERE ${whereClause}
        ORDER BY ${orderExpr}
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<RawCountRow[]>`
        SELECT COUNT(*) AS count FROM "Collection" WHERE ${whereClause}
      `,
    ]);

    return c.json({
      data:  data.map(serializeCollection),
      meta:  { page, limit, total: Number(rawTotal[0].count) },
    });
  }

  // ORM path for recent / supply / name
  const where: any = { ...chainWhere(chainFilter), isHidden: false };
  if (isFeatured === "true")  where.isFeatured = true;
  if (isFeatured === "false") where.isFeatured = false;
  if (owner)     where.owner = normalizeAddress("STARKNET", owner);
  if (service)   where.service = service;
  if (standardFilter) where.standard = { in: standardFilter };
  if (hideEmpty) where.totalSupply = { gt: 0 };

  const orderBy =
    sort === "supply" ? { totalSupply: "desc" as const } :
    sort === "name"   ? { name: "asc"  as const }        :
                        { createdAt: "desc" as const };  // "recent" — new default

  const [data, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        profile: {
          // image/displayName/description: platform-layer identity (coin launch
          // studio uploads) — list consumers (CoinCard) fall back to profile.image.
          select: { hasGatedContent: true, gatedContentTitle: true, slug: true, image: true, displayName: true, description: true },
        },
      },
    }),
    prisma.collection.count({ where }),
  ]);

  return c.json({ data: data.map(serializeCollection), meta: { page, limit, total } });
});

// GET /v1/collections/by-slug/:slug — resolve a vanity slug to a full collection
collections.get("/by-slug/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase().trim();

  const profile = await prisma.collectionProfile.findUnique({
    where: { slug },
    select: { contractAddress: true, chain: true },
  });

  if (!profile) return c.json({ error: "Collection not found" }, 404);

  // SECURITY: gatedContentUrl + gatedContentType are holder-only; fetch
  // them via GET /v1/collections/:contract/gated-content (which verifies
  // on-chain token ownership). They MUST NOT appear in the public
  // by-slug response. Whitelist-by-select makes "did I leak it" a
  // grep on this query rather than a runtime audit.
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: profile.chain, contractAddress: profile.contractAddress } },
    include: {
      profile: {
        select: {
          id: true,
          contractAddress: true,
          chain: true,
          displayName: true,
          description: true,
          image: true,
          bannerImage: true,
          websiteUrl: true,
          twitterUrl: true,
          discordUrl: true,
          telegramUrl: true,
          gatedContentTitle: true,
          hasGatedContent: true,
          slug: true,
          updatedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!col || col.deletedAt) return c.json({ error: "Collection not found" }, 404);

  return c.json({ data: { ...serializeCollection(col), profile: col.profile } });
});

// GET /v1/collections/:contract
collections.get("/:contract", async (c) => {
  const { contract } = c.req.param();
  const include = c.req.query("include");
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress("STARKNET", contract) } },
    ...(include === "profile" ? { include: { profile: true } } : {}),
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  let profileData: Record<string, unknown> | null = null;
  if (include === "profile") {
    const profile = (col as any).profile ?? null;
    if (profile) {
      // gatedContentUrl and gatedContentType are only returned to verified
      // token holders via GET /v1/collections/:contract/gated-content
      const { gatedContentUrl: _url, gatedContentType: _type, ...safeProfile } = profile;
      profileData = safeProfile;
    }
  }

  return c.json({
    data: {
      ...serializeCollection(col),
      ...(include === "profile" ? { profile: profileData } : {}),
    },
  });
});

// GET /v1/collections/:contract/tokens
collections.get("/:contract/tokens", async (c) => {
  const { contract } = c.req.param();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const sortParam = c.req.query("sort");
  const sort: "recent" | "oldest" | "name" | "price" =
    sortParam === "oldest" || sortParam === "name" || sortParam === "price"
      ? sortParam
      : "recent";
  const addr = normalizeAddress("STARKNET", contract);

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: addr } },
  });

  if (collection) {
    const hiddenCreator = await prisma.hiddenCreator.findUnique({
      where: {
        chain_address: {
          chain: collection.chain,
          address: collection.owner ?? "",
        },
      },
    });
    if (hiddenCreator) {
      return c.json({ data: [], meta: { page, limit, total: 0 } });
    }
  }

  const skip = (page - 1) * limit;

  // "price" needs a per-token cheapest-active-listing lookup — not a plain
  // column, so it goes through raw SQL (same ::numeric NULLS LAST convention
  // as /v1/orders' price_asc). Every other sort stays on the ORM path.
  if (sort === "price") {
    const [data, total] = await Promise.all([
      prisma.$queryRaw<RawTokenRow[]>`
        SELECT t.*,
          (
            SELECT MIN(o."priceRaw"::numeric)
            FROM "Order" o
            WHERE o.chain = 'STARKNET'
              AND o."nftContract" = t."contractAddress"
              AND o."nftTokenId" = t."tokenId"
              AND o.status = 'ACTIVE'::"OrderStatus"
              AND o."offerItemType" IN ('ERC721', 'ERC1155')
          ) AS "minPrice"
        FROM "Token" t
        WHERE t.chain = 'STARKNET' AND t."contractAddress" = ${addr} AND t."isHidden" = false
        ORDER BY "minPrice"::numeric ASC NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.token.count({ where: { chain: "STARKNET", contractAddress: addr, isHidden: false } }),
    ]);

    const balancesByToken = await batchTokenBalances(addr, data.map((t) => t.tokenId));
    return c.json({
      data: data.map((t) =>
        serializeToken(
          { ...t, collection: { standard: collection?.standard ?? null } },
          [],
          balancesByToken.get(t.tokenId) ?? []
        )
      ),
      meta: { page, limit, total },
    });
  }

  const [data, total] = await Promise.all([
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: addr, isHidden: false },
      orderBy:
        sort === "oldest"
          ? { createdAt: "asc" }
          : sort === "name"
            ? { name: "asc" }
            : { createdAt: "desc" },
      skip,
      take: limit,
      include: { collection: { select: { standard: true } } },
    }),
    prisma.token.count({ where: { chain: "STARKNET", contractAddress: addr, isHidden: false } }),
  ]);

  const balancesByToken = await batchTokenBalances(addr, data.map((t) => t.tokenId));

  return c.json({
    data: data.map((t) => serializeToken(t, [], balancesByToken.get(t.tokenId) ?? [])),
    meta: { page, limit, total },
  });
});

// Per-token current holders — without this the collection list returned
// balances:null, so clients couldn't tell which tokens the viewer owns
// (every card showed Buy/Offer, even to the owner). One indexed batch query,
// shared by every sort branch of GET /v1/collections/:contract/tokens.
async function batchTokenBalances(contractAddress: string, tokenIds: string[]) {
  const balanceRows = tokenIds.length
    ? await prisma.tokenBalance.findMany({
        where: {
          chain: "STARKNET",
          contractAddress,
          tokenId: { in: tokenIds },
          amount: { not: "0" },
        },
        select: { tokenId: true, owner: true, amount: true },
      })
    : [];
  const balancesByToken = new Map<string, { owner: string; amount: string }[]>();
  for (const b of balanceRows) {
    const arr = balancesByToken.get(b.tokenId) ?? [];
    arr.push({ owner: b.owner, amount: b.amount });
    balancesByToken.set(b.tokenId, arr);
  }
  return balancesByToken;
}

// POST /v1/collections/sync-tx — immediately index a CollectionCreated event from a tx receipt
// Call this right after a create_collection tx is confirmed to make the collection appear instantly.
collections.post("/sync-tx", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ txHash: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "txHash required" }, 400);

  const { txHash } = parsed.data;
  try {
    const receipt = await callRpc((provider) => provider.getTransactionReceipt(txHash));

    const collectionCreatedKey = starkNum.toHex(COLLECTION_CREATED_SELECTOR);
    const registryAddress = normalizeAddress("STARKNET", STARKNET_COLLECTION_721_CONTRACT);
    const events = (receipt as any).events ?? [];
    const collectionEvents = events.filter(
      (e: any) =>
        e.from_address &&
        normalizeAddress("STARKNET", e.from_address) === registryAddress &&
        e.keys?.[0] && starkNum.toHex(e.keys[0]) === collectionCreatedKey
    );

    if (collectionEvents.length === 0) {
      return c.json({ data: { synced: 0, message: "No CollectionCreated event found in this transaction" } });
    }

    let synced = 0;
    let unresolved = 0;
    for (const event of collectionEvents) {
      const decoded = decodeCollectionCreatedEvent(event);
      if (!decoded) continue;
      const { collectionId, owner } = decoded;
      const blockNumber = BigInt(event.block_number ?? (receipt as any).block_number ?? 0);

      let resolved = await resolveCollectionCreated({
        type: "CollectionCreated",
        collectionId,
        owner,
        blockNumber,
        txHash,
        logIndex: 0,
      });

      if (!resolved) {
        resolved = resolveCollectionFromReceipt(event, events, registryAddress, owner, blockNumber);
      }

      if (!resolved) {
        unresolved++;
        continue;
      }

      await prisma.collection.upsert({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: resolved.contractAddress } },
        create: {
          chain: "STARKNET",
          contractAddress: resolved.contractAddress,
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          baseUri: resolved.baseUri ?? undefined,
          owner: resolved.owner,
          startBlock: resolved.startBlock,
          service: "mip-erc721",
          standard: "ERC721",
          metadataStatus: "PENDING",
        },
        update: {
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          owner: resolved.owner,
          service: "mip-erc721",
          standard: "ERC721",
        },
      });

      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });
      synced++;
      log.info({ txHash, contractAddress: resolved.contractAddress, owner }, "Collection synced from tx");
    }

    if (synced === 0 && unresolved > 0) {
      // RPC couldn't resolve the just-created collection right now (typically
      // transient RPC-provider flapping on get_collection). This is NOT a
      // failure: the mirror poll re-indexes the CollectionCreated event within
      // ~6s. Return 202 (accepted, async) instead of a misleading 502 that
      // alarms the client console for a self-healing condition.
      log.warn({ txHash, unresolved }, "sync-tx: RPC unresolved — deferring to indexer poll");
      return c.json(
        {
          data: { synced, unresolved, deferred: true },
          message:
            "RPC unavailable for instant sync — this collection will be indexed by the poll shortly.",
        },
        202
      );
    }

    return c.json({ data: { synced } });
  } catch (err) {
    log.error({ err, txHash }, "sync-tx failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/collections/register — tenant-driven collection registration
collections.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.contractAddress) {
    return c.json({ error: "contractAddress is required" }, 400);
  }

  const contractAddress = normalizeAddress("STARKNET", body.contractAddress);
  const startBlock = typeof body.startBlock === "number" ? BigInt(body.startBlock) : BigInt(0);
  const standard =
    typeof body.standard === "string" && VALID_COLLECTION_STANDARDS.has(body.standard)
      ? body.standard
      : undefined;
  const service =
    typeof body.service === "string" && body.service.length > 0
      ? body.service
      : undefined;

  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (existing) {
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
      data: {
        standard,
        ...(service ? { service } : {}),
        metadataStatus: "PENDING",
      },
    });
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress });
    return c.json({ data: serializeCollection(collection) });
  }

  // standard is required to create a Collection — caller must specify ERC721
  // or ERC1155. If not, refuse rather than guess (was silently defaulting to
  // UNKNOWN before, which has been dropped from the enum).
  if (!standard) {
    return c.json({ error: "standard is required (ERC721 or ERC1155)" }, 400);
  }
  const resolvedService =
    service ?? (standard === "ERC1155" ? "external-erc1155" : "external-erc721");
  const collection = await prisma.collection.create({
    data: {
      chain: "STARKNET",
      contractAddress,
      startBlock,
      metadataStatus: "PENDING",
      standard: standard as "ERC721" | "ERC1155",
      service: resolvedService,
    },
  });

  worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress });

  return c.json({ data: serializeCollection(collection) }, 201);
});

// POST /v1/collections — register a collection (admin)
collections.post("/", authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.contractAddress) {
    return c.json({ error: "contractAddress required" }, 400);
  }

  const startBlock = body.startBlock
    ? BigInt(body.startBlock)
    : BigInt(env.INDEXER_START_BLOCK);

  const contractAddress = normalizeAddress("STARKNET", body.contractAddress);

  // standard is required to create — caller must specify ERC721 or ERC1155.
  if (body.standard !== "ERC721" && body.standard !== "ERC1155") {
    return c.json({ error: "standard is required (ERC721 or ERC1155)" }, 400);
  }
  const adminStandard = body.standard as "ERC721" | "ERC1155";
  const adminService =
    body.service ?? (adminStandard === "ERC1155" ? "external-erc1155" : "external-erc721");
  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    create: {
      chain: "STARKNET",
      contractAddress,
      name: body.name ?? null,
      symbol: body.symbol ?? null,
      description: body.description ?? null,
      image: body.image ?? null,
      baseUri: body.baseUri ?? null,
      owner: body.owner ? normalizeAddress("STARKNET", body.owner) : null,
      standard: adminStandard,
      service: adminService,
      startBlock,
    },
    update: {
      name: body.name ?? undefined,
      symbol: body.symbol ?? undefined,
      description: body.description ?? undefined,
      image: body.image ?? undefined,
      baseUri: body.baseUri ?? undefined,
      owner: body.owner ? normalizeAddress("STARKNET", body.owner) : undefined,
      standard: adminStandard,
    },
  });

  return c.json({ data: serializeCollection(col) }, 201);
});


function serializeCollection(c: any) {
  const profile = c.profile ?? null;
  return {
    id: c.id,
    chain: c.chain,
    contractAddress: c.contractAddress,
    collectionId: c.collectionId ?? null,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    image: c.image,
    owner: c.owner ?? null,
    startBlock: c.startBlock.toString(),
    metadataStatus: c.metadataStatus,
    standard: c.standard,
    isFeatured: c.isFeatured,
    isHidden: c.isHidden,
    service: c.service ?? null,
    claimedBy: c.claimedBy ?? null,
    floorPrice: c.floorPrice,
    totalVolume: c.totalVolume,
    holderCount: c.holderCount,
    totalSupply: c.totalSupply,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    profile: profile
      ? {
          hasGatedContent: profile.hasGatedContent,
          gatedContentTitle: profile.gatedContentTitle ?? null,
          slug: profile.slug ?? null,
          image: profile.image ?? null,
          displayName: profile.displayName ?? null,
          description: profile.description ?? null,
        }
      : null,
  };
}

export default collections;
