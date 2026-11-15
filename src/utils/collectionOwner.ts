import type { Chain } from "@prisma/client";
import { getService } from "@medialane/sdk";
import prisma from "../db/client.js";
import { getCollectionOwner } from "../chainRead/index.js";
import { STARKNET_COLLECTION_FACTORIES } from "../config/constants.js";
import { normalizeAddress } from "./starknet.js";

const REGISTRIES = new Set(STARKNET_COLLECTION_FACTORIES.map((a) => normalizeAddress("STARKNET", a)));

export async function currentCollectionOwner(chain: Chain, contractAddress: string): Promise<string> {
  const row = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { collectionId: true, service: true },
  });
  const factory = row?.collectionId ? getService(row.service)?.onchain?.STARKNET?.factoryAddress : undefined;
  const registry = factory && REGISTRIES.has(normalizeAddress("STARKNET", factory)) ? factory : undefined;
  return getCollectionOwner(chain, contractAddress, registry && row?.collectionId ? { address: registry, collectionId: row.collectionId } : undefined);
}
