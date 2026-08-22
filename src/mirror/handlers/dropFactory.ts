import { num, Contract } from "starknet";
import { DropCollectionABI } from "@medialane/sdk/starknet";
import { createProvider } from "../../utils/starknet.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:dropFactory");

export async function handleDropCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 4 || !data || data.length < 1) {
      log.warn({ txHash }, "DropCreated: unexpected key/data length, skipping");
      return;
    }

    const dropIdLow = BigInt(keys[1]);
    const dropIdHigh = BigInt(keys[2]);
    const dropId = ((dropIdHigh << 128n) | dropIdLow).toString();
    const organizer = normalizeAddress("STARKNET", keys[3]);
    const collectionAddress = normalizeAddress("STARKNET", data[0]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash, dropId }, "DropCreated has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: collectionAddress,
      service: "drop-collection",
      standard: "ERC721",
      collectionId: dropId,
      owner: organizer,
      startBlock,
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: collectionAddress });

    await seedDropConditions(collectionAddress);

    log.info({ dropId, collectionAddress, organizer }, "Drop collection indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropCreated failed");
    throw err;
  }
}

export async function handleDropAllowlistUpdated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 2 || !data || data.length < 1) {
      log.warn({ txHash }, "Drop AllowlistUpdated: unexpected key/data length, skipping");
      return;
    }

    const collectionAddress = normalizeAddress("STARKNET", event.from_address);
    const walletAddress = normalizeAddress("STARKNET", keys[1]);
    const allowed = BigInt(data[0]) !== 0n;

    await prisma.popAllowlist.upsert({
      where: {
        chain_collectionAddress_walletAddress: {
          chain: "STARKNET",
          collectionAddress,
          walletAddress,
        },
      },
      create: { chain: "STARKNET", collectionAddress, walletAddress, allowed },
      update: { allowed },
    });

    log.debug({ collectionAddress, walletAddress, allowed }, "Drop AllowlistUpdated indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropAllowlistUpdated failed");
    throw err;
  }
}

function u256(low: string, high: string): bigint {
  return (BigInt(high) << 128n) | BigInt(low);
}

export interface ParsedClaimConditions {
  collectionAddress: string;
  startTime: bigint;
  endTime: bigint;
  price: string;
  maxPerWallet: string;
}

export function parseClaimConditionsUpdated(
  event: RawStarknetEvent,
): ParsedClaimConditions | null {
  const data = event.data;
  if (!data || data.length < 7) return null;
  return {
    collectionAddress: normalizeAddress("STARKNET", event.from_address),
    startTime: BigInt(data[0]),
    endTime: BigInt(data[1]),
    price: u256(data[2], data[3]).toString(),
    maxPerWallet: u256(data[4], data[5]).toString(),
  };
}

export interface DropChainConditions {
  maxSupply: bigint;
  startTime: bigint;
  endTime: bigint;
  price: bigint;
  paymentToken: string;
  maxPerWallet: bigint;
}

export function buildDropConditionsSeed(collectionAddress: string, chain: DropChainConditions) {
  return {
    chain: "STARKNET" as const,
    collectionAddress,
    maxSupply: chain.maxSupply.toString(),
    price: chain.price.toString(),
    paymentToken: chain.paymentToken,
    startTime: chain.startTime,
    endTime: chain.endTime,
    maxPerWallet: chain.maxPerWallet.toString(),
  };
}

export async function handleDropClaimConditionsUpdated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const parsed = parseClaimConditionsUpdated(event);
    if (!parsed) {
      log.warn({ txHash }, "ClaimConditionsUpdated: unexpected data length, skipping");
      return;
    }

    await prisma.dropClaimConditions.upsert({
      where: {
        chain_collectionAddress: {
          chain: "STARKNET",
          collectionAddress: parsed.collectionAddress,
        },
      },
      create: {
        chain: "STARKNET",
        collectionAddress: parsed.collectionAddress,
        maxSupply: "0",
        price: parsed.price,
        paymentToken: "0x0",
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        maxPerWallet: parsed.maxPerWallet,
      },
      update: {
        price: parsed.price,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        maxPerWallet: parsed.maxPerWallet,
      },
    });

    log.debug({ collectionAddress: parsed.collectionAddress }, "Drop ClaimConditionsUpdated indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropClaimConditionsUpdated failed");
    throw err;
  }
}

async function seedDropConditions(collectionAddress: string): Promise<void> {
  try {
    const col = new Contract({
      abi: DropCollectionABI as never,
      address: collectionAddress,
      providerOrAccount: createProvider() as never,
    });
    const [cond, max] = await Promise.all([
      col.call("get_claim_conditions", []) as Promise<{
        start_time: bigint; end_time: bigint; price: bigint;
        payment_token: bigint | string; max_quantity_per_wallet: bigint;
      }>,
      col.call("get_max_supply", []) as Promise<bigint>,
    ]);
    const paymentToken =
      typeof cond.payment_token === "bigint"
        ? "0x" + cond.payment_token.toString(16)
        : String(cond.payment_token);
    const seed = buildDropConditionsSeed(collectionAddress, {
      maxSupply: BigInt(max),
      startTime: BigInt(cond.start_time),
      endTime: BigInt(cond.end_time),
      price: BigInt(cond.price),
      paymentToken,
      maxPerWallet: BigInt(cond.max_quantity_per_wallet),
    });
    await prisma.dropClaimConditions.upsert({
      where: { chain_collectionAddress: { chain: "STARKNET", collectionAddress } },
      create: seed,
      update: { maxSupply: seed.maxSupply, paymentToken: seed.paymentToken },
    });
  } catch (err) {
    log.warn({ err, collectionAddress }, "drop conditions seed failed — ClaimConditionsUpdated will fill it");
  }
}
