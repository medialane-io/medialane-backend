import { num, shortString } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCoin } from "../../utils/coin.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:creatorCoinFactory");

function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

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

    const totalSupply = (BigInt(data[3]) + (BigInt(data[4]) << 128n)).toString();
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
      totalSupply,

      creator: owner,
      startBlock,
    });

    log.info({ coinAddress, owner, name, symbol }, "Creator Coin indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleCreatorCoinCreated failed");
    throw err;
  }
}
