import type { Chain, Prisma } from "@prisma/client";
import type { OwnershipFact } from "../../chainRead/ownership.js";

/** Stores ownership exactly as read from the chain: ERC-721 has one holder or none, ERC-1155 rows hold the read amount. */
export async function writeOwnership(
  tx: Prisma.TransactionClient,
  chain: Chain,
  facts: OwnershipFact[],
): Promise<void> {
  for (const fact of facts) {
    const { contractAddress, tokenId } = fact;
    if (fact.standard === "ERC721") {
      await tx.tokenBalance.deleteMany({
        where: { chain, contractAddress, tokenId, ...(fact.owner ? { owner: { not: fact.owner } } : {}) },
      });
      if (fact.owner) await upsertAmount(tx, chain, contractAddress, tokenId, fact.owner, "1");
      continue;
    }
    if (fact.amount > 0n) {
      await upsertAmount(tx, chain, contractAddress, tokenId, fact.owner, fact.amount.toString());
    } else {
      await tx.tokenBalance.deleteMany({ where: { chain, contractAddress, tokenId, owner: fact.owner } });
    }
  }
}

function upsertAmount(
  tx: Prisma.TransactionClient,
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  owner: string,
  amount: string,
) {
  return tx.tokenBalance.upsert({
    where: { chain_contractAddress_tokenId_owner: { chain, contractAddress, tokenId, owner } },
    create: { chain, contractAddress, tokenId, owner, amount },
    update: { amount },
  });
}
