import { Hono } from "hono";
import { z } from "zod";
import { shortString } from "starknet";
import type { Coin } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress, callRpc } from "../../utils/starknet.js";
import { CREATOR_COIN_FACTORY_CONTRACT } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { upsertCoin } from "../../utils/coin.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";

const log = createLogger("routes:coins");
const coins = new Hono();

/** Coin.startBlock is BigInt — stringify it for JSON responses. */
function serializeCoin(coin: Coin) {
  return { ...coin, startBlock: coin.startBlock.toString() };
}

/** Decode a felt252 short string (OZ 0.8 ERC-20 name/symbol); null on failure. */
function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * POST /v1/coins/sync — index a Creator Coin on demand.
 *
 * The primary indexing path for Creator Coins: the dapp calls this right after a
 * successful launch so the coin appears instantly (the 50s factory poll is only a
 * backstop). Also used to backfill a specific coin (e.g. the smoke-launch coin).
 *
 * Verifies the address via the Factory's `is_creator_coin` before writing — only
 * genuine Factory-deployed coins can be indexed through this route. Reads
 * name/symbol on-chain (ERC-20 felt252) and upserts a Collection(ERC20,
 * "creator-coin"). Idempotent.
 *
 * Body: { coinAddress: string, owner?: string }
 */
coins.post("/sync", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({ coinAddress: z.string().min(3), owner: z.string().optional() })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "coinAddress required" }, 400);

  if (!CREATOR_COIN_FACTORY_CONTRACT) {
    return c.json({ error: "Creator Coin factory not configured" }, 503);
  }
  const coinAddress = normalizeAddress("STARKNET", parsed.data.coinAddress);

  try {
    // Gate: only genuine Factory-deployed Creator Coins.
    const verify = await callRpc((provider) =>
      provider.callContract({
        contractAddress: CREATOR_COIN_FACTORY_CONTRACT,
        entrypoint: "is_creator_coin",
        calldata: [coinAddress],
      })
    );
    const isCreatorCoin = verify.length > 0 && BigInt(verify[0] ?? "0x0") !== 0n;
    if (!isCreatorCoin) {
      return c.json({ error: "Address is not a Creator Coin (is_creator_coin = false)" }, 400);
    }

    // ERC-20 metadata (OZ 0.8 → felt252 short strings).
    const [nameRes, symbolRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress: coinAddress, entrypoint: "symbol", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress: coinAddress,
      service: "creator-coin",
      name,
      symbol,
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

// GET /v1/coins — paginated coin list; ?service=creator-coin|external-erc20, ?page, ?limit
coins.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 24)));
  const service = c.req.query("service");
  const where = { chain: "STARKNET" as const, isHidden: false, ...(service ? { service } : {}) };
  const [rows, total] = await Promise.all([
    prisma.coin.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.coin.count({ where }),
  ]);
  return c.json({ data: rows.map(serializeCoin), meta: { page, limit, total } });
});

// GET /v1/coins/:contract — single coin
coins.get("/:contract", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);
  return c.json({ data: serializeCoin(coin) });
});

export default coins;
