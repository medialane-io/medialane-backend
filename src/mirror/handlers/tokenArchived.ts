import prisma from "../../db/client.js";
import { readArchived } from "../../chainRead/archived.js";
import { TOKEN_ARCHIVED_BATCH_SELECTOR } from "../../config/constants.js";
import { sameFelt } from "@medialane/sdk/starknet";
import { serviceForFactory } from "../../utils/factoryService.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { u256ToBigInt } from "../../utils/bigint.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

interface ArchivedPair {
  collectionId: string;
  tokenId: string;
}

function span(data: string[], from: number): { values: string[]; next: number } {
  const length = Number(BigInt(data[from] ?? "0x0"));
  const values: string[] = [];
  for (let i = 0; i < length; i++) {
    values.push(u256ToBigInt(data[from + 1 + 2 * i]!, data[from + 2 + 2 * i]!).toString());
  }
  return { values, next: from + 1 + 2 * length };
}

function pairsOf(event: RawStarknetEvent): ArchivedPair[] {
  if (sameFelt(event.keys[0], TOKEN_ARCHIVED_BATCH_SELECTOR)) {
    const collections = span(event.data, 0);
    const tokens = span(event.data, collections.next);
    return collections.values.map((collectionId, i) => ({ collectionId, tokenId: tokens.values[i]! }));
  }
  if (event.keys.length < 5) return [];
  return [
    {
      collectionId: u256ToBigInt(event.keys[1]!, event.keys[2]!).toString(),
      tokenId: u256ToBigInt(event.keys[3]!, event.keys[4]!).toString(),
    },
  ];
}

export async function applyTokensArchived(events: RawStarknetEvent[]): Promise<void> {
  for (const event of events) {
    const registry = normalizeAddress("STARKNET", event.from_address);
    for (const { collectionId, tokenId } of pairsOf(event)) {
      const collection = await prisma.collection.findFirst({
        where: { chain: "STARKNET", service: serviceForFactory(registry), collectionId },
        select: { contractAddress: true },
      });
      if (!collection) continue;
      const { contractAddress } = collection;
      if (!(await readArchived({ contractAddress, tokenId }))) continue;
      await prisma.$transaction([
        prisma.token.updateMany({ where: { chain: "STARKNET", contractAddress, tokenId }, data: { isArchived: true, isHidden: true } }),
        prisma.order.updateMany({
          where: { chain: "STARKNET", nftContract: contractAddress, nftTokenId: tokenId, status: "ACTIVE" },
          data: { status: "CANCELLED" },
        }),
      ]);
    }
  }
}
