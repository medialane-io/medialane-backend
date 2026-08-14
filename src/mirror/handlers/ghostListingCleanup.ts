import { type Chain, type Prisma } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:ghostListingCleanup");

export async function cleanupGhostListings(
  fulfilledOrderHash: string,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const fulfilledOrder = await tx.order.findUnique({
    where: { chain_orderHash: { chain, orderHash: fulfilledOrderHash } },
    select: { nftContract: true, nftTokenId: true, offerer: true },
  });

  if (!fulfilledOrder?.nftContract || !fulfilledOrder.nftTokenId) return;

  const { nftContract, nftTokenId, offerer } = fulfilledOrder;

  const ghosts = await tx.order.findMany({
    where: {
      chain,
      nftContract,
      nftTokenId,
      offerer,
      status: "ACTIVE",
      orderHash: { not: fulfilledOrderHash },

      offerItemType: { in: ["ERC721", "ERC1155"] },
    },
    select: { orderHash: true },
  });

  if (ghosts.length === 0) return;

  await tx.order.updateMany({
    where: {
      chain,
      orderHash: { in: ghosts.map((o) => o.orderHash) },
    },
    data: { status: "CANCELLED" },
  });

  log.info(
    { fulfilledOrderHash, nftContract, nftTokenId, offerer, count: ghosts.length },
    "Ghost listings cancelled after fulfillment"
  );
}
