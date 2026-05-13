import { type Chain, type Prisma } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:ghostListingCleanup");

/**
 * After an order is fulfilled, cancel any other ACTIVE sell-listings for the
 * same (nftContract, nftTokenId, offerer) triplet.
 *
 * When a seller accepts a bid (or a buyer fulfills a listing) the NFT changes
 * hands. Any remaining listings from the same seller become unfulfillable —
 * the on-chain transfer_from would revert. Marking them CANCELLED here keeps
 * the DB consistent and prevents ghost listings from appearing in the UI.
 *
 * Bids (offerItemType = "ERC20") are intentionally excluded: a bid offerer is
 * a buyer, not the NFT holder, so other bids from the same address are valid.
 *
 * Must be called inside the same Prisma transaction as handleOrderFulfilled /
 * handleOrderFulfilled1155 so the cleanup is atomic with the fill.
 */
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
      // Only listings — bids have offerItemType "ERC20" and are not affected
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
