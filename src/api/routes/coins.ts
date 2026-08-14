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
import { upsertCoin, readTotalSupply } from "../../utils/coin.js";
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
    if (!isCreatorCoin) {
      return c.json({ error: "Address is not a Creator Coin (is_creator_coin = false)" }, 400);
    }

    const [nameRes, symbolRes, decRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint: "symbol", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint: "decimals", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");
    const decimals = decRes[0] != null ? Number(BigInt(decRes[0])) : 18;

    const totalSupply = await readTotalSupply(coinAddress).catch(() => null);

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress: coinAddress,
      service: "creator-coin",
      name,
      symbol,
      decimals,
      totalSupply,
      creator: parsed.data.owner ? normalizeAddress("STARKNET", parsed.data.owner) : null,
      startBlock: BigInt(env.CREATOR_COIN_START_BLOCK),
    });

    const coin = await prisma.coin.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: coinAddress } },
    });
    log.info({ coinAddress, name, symbol }, "Creator Coin synced on demand");
    return c.json({ data: coin ? serializeCoin(coin) : { contractAddress: coinAddress, service: "creator-coin", standard: "ERC20", name, symbol } }, 201);
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
  const [rows, total] = await Promise.all([
    prisma.coin.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.coin.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeCoin), meta: { page, limit, total } });
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
