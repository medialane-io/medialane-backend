import { CallData, createAbiParser, events as starknetEvents, num } from "starknet";
import { DropFactoryABI } from "@medialane/sdk/starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:dropFactory");

const abi = DropFactoryABI as never;
const abiEvents = starknetEvents.getAbiEvents(abi);
const abiStructs = CallData.getAbiStruct(abi);
const abiEnums = CallData.getAbiEnum(abi);
const abiParser = createAbiParser(abi);

/** Every creation-time fact of a drop; numbers as decimal strings. */
export interface DropCreated {
  dropId: string;
  organizer: string;
  collectionAddress: string;
  name: string;
  symbol: string;
  baseUri: string;
  maxSupply: string;
  startTime: string;
  endTime: string;
  price: string;
  paymentToken: string;
  maxPerWallet: string;
  allowlistRoot: string;
}

interface Decoded {
  drop_id: bigint;
  organizer: bigint;
  collection_address: bigint;
  name: string;
  symbol: string;
  base_uri: string;
  max_supply: bigint;
  terms: { start_time: bigint; end_time: bigint; price: bigint; payment_token: bigint; max_per_wallet: bigint };
  allowlist_root: bigint;
}

const address = (v: bigint) => normalizeAddress("STARKNET", num.toHex(v));

export function parseDropCreated(event: RawStarknetEvent): DropCreated | null {
  const parsed = starknetEvents.parseEvents(
    [{ ...event, keys: event.keys.map((k) => num.toHex(k)) } as never],
    abiEvents,
    abiStructs,
    abiEnums,
    abiParser,
  );
  const entry = parsed[0];
  const key = entry && Object.keys(entry).find((k) => k.endsWith("::DropCreated"));
  if (!entry || !key) return null;
  const d = entry[key] as unknown as Decoded;
  return {
    dropId: BigInt(d.drop_id).toString(),
    organizer: address(d.organizer),
    collectionAddress: address(d.collection_address),
    name: d.name,
    symbol: d.symbol,
    baseUri: d.base_uri,
    maxSupply: BigInt(d.max_supply).toString(),
    startTime: BigInt(d.terms.start_time).toString(),
    endTime: BigInt(d.terms.end_time).toString(),
    price: BigInt(d.terms.price).toString(),
    paymentToken: address(d.terms.payment_token),
    maxPerWallet: BigInt(d.terms.max_per_wallet).toString(),
    allowlistRoot: num.toHex(d.allowlist_root),
  };
}

export function dropRow(d: DropCreated, block: bigint) {
  return {
    chain: "STARKNET" as const,
    collectionAddress: d.collectionAddress,
    dropId: d.dropId,
    organizer: d.organizer,
    maxSupply: d.maxSupply,
    startTime: d.startTime,
    endTime: d.endTime,
    price: d.price,
    paymentToken: d.paymentToken,
    maxPerWallet: d.maxPerWallet,
    allowlistRoot: d.allowlistRoot,
    allowlistRootBlock: block,
    createdBlock: block,
  };
}

/** Indexes the drop and its collection; returns the collection address, or null when skipped. */
export async function handleDropCreated(event: RawStarknetEvent): Promise<string | null> {
  const txHash = event.transaction_hash ?? "";
  try {
    const created = parseDropCreated(event);
    if (!created) {
      log.warn({ txHash }, "DropCreated could not be decoded, skipping");
      return null;
    }
    if (created.collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash }, "DropCreated has zero collection_address, skipping");
      return null;
    }
    const block = BigInt(event.block_number ?? 0);
    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: created.collectionAddress,
      service: "drop-collection",
      standard: "ERC721",
      collectionId: created.dropId,
      name: created.name,
      symbol: created.symbol,
      baseUri: created.baseUri,
      owner: created.organizer,
      startBlock: block,
    });
    // Creation facts never change; the allowlist root is updated by AllowlistRootSet.
    await prisma.drop.upsert({
      where: { chain_collectionAddress: { chain: "STARKNET", collectionAddress: created.collectionAddress } },
      create: dropRow(created, block),
      update: {},
    });
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: created.collectionAddress });
    log.info({ dropId: created.dropId, collectionAddress: created.collectionAddress, organizer: created.organizer }, "Drop indexed");
    return created.collectionAddress;
  } catch (err) {
    log.error({ err, txHash }, "handleDropCreated failed");
    throw err;
  }
}
