import { num } from "starknet";
import prisma from "../../db/client.js";
import { COLLECTION_OWNERSHIP_TRANSFERRED_SELECTOR, OWNERSHIP_TRANSFERRED_SELECTOR } from "../../config/constants.js";
import { currentCollectionOwner } from "../../utils/collectionOwner.js";
import { serviceForFactory } from "../../utils/factoryService.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { u256ToBigInt } from "../../utils/bigint.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const SEL_REGISTRY = num.toHex(COLLECTION_OWNERSHIP_TRANSFERRED_SELECTOR);
const SEL_OWNABLE = num.toHex(OWNERSHIP_TRANSFERRED_SELECTOR);

async function contractOf(event: RawStarknetEvent): Promise<string | null> {
  const selector = event.keys[0] ? num.toHex(event.keys[0]) : null;
  const emitter = normalizeAddress("STARKNET", event.from_address);
  if (selector === SEL_OWNABLE) return emitter;
  if (selector !== SEL_REGISTRY || event.keys.length < 3) return null;
  const row = await prisma.collection.findFirst({
    where: {
      chain: "STARKNET",
      service: serviceForFactory(emitter),
      collectionId: u256ToBigInt(event.keys[1]!, event.keys[2]!).toString(),
    },
    select: { contractAddress: true },
  });
  return row?.contractAddress ?? null;
}

export async function applyOwnershipChanges(events: RawStarknetEvent[]): Promise<void> {
  const changed = new Set<string>();
  for (const event of events) {
    const contract = await contractOf(event);
    if (contract) changed.add(contract);
  }
  for (const contractAddress of changed) {
    const owner = await currentCollectionOwner("STARKNET", contractAddress);
    await prisma.collection.updateMany({ where: { chain: "STARKNET", contractAddress }, data: { owner } });
  }
}
