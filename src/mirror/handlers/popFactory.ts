import { CallData, createAbiParser, events as starknetEvents, num } from "starknet";
import { POPFactoryABI } from "@medialane/sdk/starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:popFactory");

const abi = POPFactoryABI as never;
const abiEvents = starknetEvents.getAbiEvents(abi);
const abiStructs = CallData.getAbiStruct(abi);
const abiEnums = CallData.getAbiEnum(abi);
const abiParser = createAbiParser(abi);

export interface PopCollectionCreated {
  collectionId: string;
  organizer: string;
  collectionAddress: string;
  name: string;
  symbol: string;
  baseUri: string;
  claimEndTime: bigint;
}

interface Decoded {
  collection_id: bigint;
  organizer: bigint;
  collection_address: bigint;
  name: string;
  symbol: string;
  base_uri: string;
  claim_end_time: bigint;
}

/** Decodes a POP factory `CollectionCreated` event from the factory ABI; null for any other event. */
export function parsePopCollectionCreated(event: RawStarknetEvent): PopCollectionCreated | null {
  const parsed = starknetEvents.parseEvents(
    [{ ...event, keys: event.keys.map((k) => num.toHex(k)) } as never],
    abiEvents,
    abiStructs,
    abiEnums,
    abiParser,
  );
  const entry = parsed[0];
  if (!entry) return null;
  const key = Object.keys(entry).find((k) => k.endsWith("::CollectionCreated"));
  if (!key) return null;
  const d = entry[key] as unknown as Decoded;
  return {
    collectionId: BigInt(d.collection_id).toString(),
    organizer: normalizeAddress("STARKNET", num.toHex(d.organizer)),
    collectionAddress: normalizeAddress("STARKNET", num.toHex(d.collection_address)),
    name: d.name,
    symbol: d.symbol,
    baseUri: d.base_uri,
    claimEndTime: BigInt(d.claim_end_time),
  };
}

export async function handlePopCollectionCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const created = parsePopCollectionCreated(event);
    if (!created) {
      log.warn({ txHash }, "POP CollectionCreated could not be decoded, skipping");
      return;
    }
    if (created.collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash }, "POP CollectionCreated has zero collection_address, skipping");
      return;
    }

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: created.collectionAddress,
      service: "pop-protocol",
      standard: "ERC721",
      collectionId: created.collectionId,
      name: created.name,
      symbol: created.symbol,
      baseUri: created.baseUri,
      owner: created.organizer,
      startBlock: BigInt(event.block_number ?? 0),
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: created.collectionAddress });
    log.info(
      { collectionId: created.collectionId, collectionAddress: created.collectionAddress, organizer: created.organizer },
      "POP collection indexed",
    );
  } catch (err) {
    log.error({ err, txHash }, "handlePopCollectionCreated failed");
    throw err;
  }
}
