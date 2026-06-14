import { num, shortString } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCoin } from "../../utils/coin.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:creatorCoinFactory");

/** Decode a felt252 short string (name/symbol); fall back to the raw hex. */
function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * Handle a CreatorCoinCreated event from the Creator Coin factory.
 *
 * The event has no `#[key]` fields, so everything is in `data` (declaration order):
 *   keys[0] = selector("CreatorCoinCreated")
 *   data[0] = owner (ContractAddress)
 *   data[1] = name (felt252 short string)
 *   data[2] = symbol (felt252 short string)
 *   data[3] = initial_supply.low  (u256 split)
 *   data[4] = initial_supply.high
 *   data[5] = creator_coin_address (ContractAddress)
 *
 * A Creator Coin is a fixed-supply ERC-20, indexed as a Collection
 * (standard ERC20, service "creator-coin"). Trading happens on external Ekubo;
 * the dapp surfaces a `swap` affordance — no Order rows here.
 */
export async function handleCreatorCoinCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const data = event.data;
    if (!data || data.length < 6) {
      log.warn({ txHash, len: data?.length }, "CreatorCoinCreated: unexpected data length, skipping");
      return;
    }

    const owner = normalizeAddress("STARKNET", data[0]);
    const name = decodeShortStr(data[1]);
    const symbol = decodeShortStr(data[2]);
    const coinAddress = normalizeAddress("STARKNET", data[5]);

    if (coinAddress === ZERO_ADDRESS) {
      log.warn({ txHash }, "CreatorCoinCreated has zero coin address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress: coinAddress,
      service: "creator-coin",
      name,
      symbol,
      // Trustless: `creator` comes from the factory's CreatorCoinCreated event,
      // never a request param (on-chain owner() is renounced at launch).
      creator: owner,
      startBlock,
    });

    // No metadata-fetch job — name/symbol came from the event; coins have no token_uri.
    log.info({ coinAddress, owner, name, symbol }, "Creator Coin indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleCreatorCoinCreated failed");
    throw err;
  }
}
