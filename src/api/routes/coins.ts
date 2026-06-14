import { Hono } from "hono";
import { z } from "zod";
import { shortString } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress, callRpc } from "../../utils/starknet.js";
import { CREATOR_COIN_FACTORY_CONTRACT } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";

const log = createLogger("routes:coins");
const coins = new Hono();

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

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: coinAddress,
      service: "creator-coin",
      standard: "ERC20",
      name,
      symbol,
      owner: parsed.data.owner ? normalizeAddress("STARKNET", parsed.data.owner) : null,
      startBlock: BigInt(env.CREATOR_COIN_START_BLOCK),
    });

    // ERC-20 branch in COLLECTION_METADATA_FETCH just marks FETCHED (no token_uri).
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: coinAddress });

    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: coinAddress } },
      select: { contractAddress: true, service: true, standard: true, name: true, symbol: true, owner: true, metadataStatus: true },
    });
    log.info({ coinAddress, name, symbol }, "Creator Coin synced on demand");
    return c.json({ data: col ?? { contractAddress: coinAddress, service: "creator-coin", standard: "ERC20", name, symbol } }, 201);
  } catch (err) {
    log.error({ err, coinAddress }, "coin sync failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

export default coins;
