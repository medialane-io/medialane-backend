import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import { parseSingleChain, parseChainFilter } from "../utils/chainFilter.js";
import type { AppEnv } from "../../types/hono.js";
import { z } from "zod";
import { shortString } from "starknet";
import type { Coin } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress, callRpc } from "../../utils/starknet.js";
import { STARKNET_CREATOR_COIN_FACTORY_CONTRACT } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { upsertCoin, resolveCoin } from "../../utils/coin.js";
import { getCollectionOwner } from "../../chainRead/index.js";
import { getCoinPrices } from "../../utils/coinPrice.js";
import { getTokenBySymbol } from "@medialane/sdk";
import { identityAuth } from "../middleware/identityAuth.js";
import { buildCoinListWhere } from "./coins.filters.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";

const log = createLogger("routes:coins");
const coins = new Hono<AppEnv>();

function serializeCoin(coin: Coin) {
  return { ...coin, startBlock: coin.startBlock.toString() };
}

function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

coins.post("/sync", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      coinAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet address"),
      owner: z.string().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "coinAddress required" }, 400);

  if (!STARKNET_CREATOR_COIN_FACTORY_CONTRACT) {
    return c.json({ error: "Creator Coin factory not configured" }, 503);
  }
  const coinAddress = normalizeAddress("STARKNET", parsed.data.coinAddress);

  try {

    const verify = await callRpc((provider) =>
      provider.callContract({
        contractAddress: STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
        entrypoint: "is_creator_coin",
        calldata: [coinAddress],
      })
    );
    const isCreatorCoin = verify.length > 0 && BigInt(verify[0] ?? "0x0") !== 0n;

    const resolved = await resolveCoin(coinAddress, isCreatorCoin);
    if (!resolved.ok) {
      return c.json(
        {
          error:
            resolved.reason === "not_erc20"
              ? "Address does not expose ERC-20 name or symbol"
              : "Address does not expose an ERC-20 total supply",
        },
        400,
      );
    }

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress: coinAddress,
      ...resolved.coin,
      creator: parsed.data.owner ? normalizeAddress("STARKNET", parsed.data.owner) : null,
      startBlock: isCreatorCoin ? BigInt(env.CREATOR_COIN_START_BLOCK) : BigInt(0),
    });

    const coin = await prisma.coin.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: coinAddress } },
    });
    log.info({ coinAddress, service: resolved.coin.service }, "Coin synced on demand");
    return c.json({ data: coin ? serializeCoin(coin) : { contractAddress: coinAddress, ...resolved.coin, standard: "ERC20" } }, 201);
  } catch (err) {
    log.error({ err, coinAddress }, "coin sync failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

coins.get("/", publicCache(30), async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 24)));
  const service = c.req.query("service");
  const creator = c.req.query("creator") ?? undefined;
  const where = buildCoinListWhere({ chainFilter: parseChainFilter(c.req.query("chain")) ?? undefined, service: service ?? undefined, creator });
  const [rows, total, grouped] = await Promise.all([
    prisma.coin.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.coin.count({ where }),

    prisma.coin.groupBy({ by: ["service"], where: { isHidden: false }, _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.service] = g._count._all;

  return c.json({ data: rows.map(serializeCoin), meta: { page, limit, total, counts } });
});

coins.post("/claim", identityAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({ coinAddress: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet address") })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "coinAddress required" }, 400);

  const coinAddress = normalizeAddress("STARKNET", parsed.data.coinAddress);
  const wallet = c.get("walletAddress") as string;

  let owner: string;
  try {
    owner = await getCollectionOwner("STARKNET", coinAddress);
  } catch {
    return c.json({ verified: false, reason: "owner_check_failed" });
  }

  if (owner === normalizeAddress("STARKNET", "0x0") || owner !== wallet) {
    return c.json({ verified: false, reason: "owner_mismatch" });
  }

  let isCreatorCoin = false;
  if (STARKNET_CREATOR_COIN_FACTORY_CONTRACT) {
    const verify = await callRpc((provider) =>
      provider.callContract({
        contractAddress: STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
        entrypoint: "is_creator_coin",
        calldata: [coinAddress],
      }),
    ).catch(() => [] as string[]);
    isCreatorCoin = verify.length > 0 && BigInt(verify[0] ?? "0x0") !== 0n;
  }

  const resolved = await resolveCoin(coinAddress, isCreatorCoin);
  if (!resolved.ok) return c.json({ verified: false, reason: resolved.reason });

  await upsertCoin(prisma, {
    chain: "STARKNET",
    contractAddress: coinAddress,
    ...resolved.coin,
    creator: wallet,
    startBlock: isCreatorCoin ? BigInt(env.CREATOR_COIN_START_BLOCK) : BigInt(0),
  });

  await prisma.collectionClaim.create({
    data: {
      contractAddress: coinAddress,
      chain: "STARKNET",
      claimantAddress: wallet,
      status: "AUTO_APPROVED",
      verificationMethod: "ONCHAIN",
    },
  });

  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: coinAddress } },
  });
  log.info({ coinAddress, wallet, service: resolved.coin.service }, "Coin claimed on chain");
  return c.json({ verified: true, coin: coin ? serializeCoin(coin) : null });
});

coins.get("/claims", async (c) => {
  const status = c.req.query("status") ?? "PENDING";
  const claims = await prisma.collectionClaim.findMany({
    where: { status: status as never },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return c.json({ data: claims });
});

coins.get("/prices", publicCache(30), async (c) => {
  const rows = await prisma.coin.findMany({
    where: { isHidden: false },
    select: { contractAddress: true, decimals: true },
  });

  const inputs = rows.map((r) => ({ contractAddress: r.contractAddress, decimals: r.decimals }));

  const strk = getTokenBySymbol("STRK");
  if (strk) inputs.push({ contractAddress: normalizeAddress("STARKNET", strk.address), decimals: strk.decimals });

  const prices = await getCoinPrices(inputs);
  return c.json({ data: prices });
});

coins.get("/:contract", publicCache(30), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const contract = normalizeAddress(chain, c.req.param("contract"));
  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain, contractAddress: contract } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);
  return c.json({ data: serializeCoin(coin) });
});

coins.patch("/:contract", identityAuth, async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract") ?? "");
  const jwtWallet = c.get("walletAddress") as string;
  const parsed = z
    .object({

      image: z.string().max(400).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);
  if (!coin.creator || normalizeAddress("STARKNET", coin.creator) !== jwtWallet) {
    return c.json({ error: "Only the coin creator can edit this coin" }, 403);
  }

  const updated = await prisma.coin.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
    data: {
      ...(parsed.data.image !== undefined ? { image: parsed.data.image } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    },
  });
  return c.json({ data: serializeCoin(updated) });
});

export default coins;
