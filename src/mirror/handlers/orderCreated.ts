import { Contract } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import { IPMarketplaceABI } from "../../config/abis.js";
import { MARKETPLACE_CONTRACT } from "../../config/constants.js";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import type { ParsedOrderCreated, OnChainOrderDetails } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";

const log = createLogger("handler:orderCreated");

export async function handleOrderCreated(
  event: ParsedOrderCreated,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<string | null> {
  const provider = createProvider();
  const contract = new Contract(
    IPMarketplaceABI as any,
    MARKETPLACE_CONTRACT,
    provider
  );

  let details: OnChainOrderDetails;
  try {
    const raw = await withRetry(
      () => contract.get_order_details(event.orderHash),
      3,   // attempts
      500  // base delay ms (500 → 1000 → 2000)
    );
    details = parseOrderDetails(raw);
  } catch (err) {
    log.error(
      { err, orderHash: event.orderHash },
      "Failed to fetch order details from RPC after retries — order will be missing"
    );
    return null;
  }

  // Listing: offer side is ERC721/ERC1155 → NFT is the offer, price is on consideration side (ERC20)
  // Bid: offer side is ERC20, consideration side is ERC721/ERC1155 → price is on offer side (ERC20)
  const isListing = details.offerItemType === "ERC721" || details.offerItemType === "ERC1155";
  const isBid = details.considerationItemType === "ERC721" || details.considerationItemType === "ERC1155";
  const priceTokenAddress = isBid ? details.offerToken : details.considerationToken;
  const priceRaw = isBid ? details.offerStartAmount : details.considerationStartAmount;
  const token = getTokenByAddress(priceTokenAddress);
  const priceFormatted = token ? formatAmount(priceRaw, token.decimals) : priceRaw;
  const currencySymbol = token?.symbol ?? null;
  const nftContract = isListing
    ? details.offerToken
    : isBid
    ? details.considerationToken
    : null;
  const nftTokenId = isListing
    ? details.offerIdentifier
    : isBid
    ? details.considerationIdentifier
    : null;

  await tx.order.upsert({
    where: { chain_orderHash: { chain, orderHash: event.orderHash } },
    create: {
      chain,
      orderHash: event.orderHash,
      offerer: details.offerer,
      offerItemType: details.offerItemType,
      offerToken: details.offerToken,
      offerIdentifier: details.offerIdentifier,
      offerStartAmount: details.offerStartAmount,
      offerEndAmount: details.offerEndAmount,
      considerationItemType: details.considerationItemType,
      considerationToken: details.considerationToken,
      considerationIdentifier: details.considerationIdentifier,
      considerationStartAmount: details.considerationStartAmount,
      considerationEndAmount: details.considerationEndAmount,
      considerationRecipient: details.considerationRecipient,
      startTime: details.startTime,
      endTime: details.endTime,
      status: "ACTIVE",
      createdBlockNumber: event.blockNumber,
      createdTxHash: event.txHash,
      nftContract,
      nftTokenId,
      priceRaw,
      priceFormatted,
      currencySymbol,
      marketplaceContract: normalizeAddress(MARKETPLACE_CONTRACT),
    },
    update: {
      offerer: details.offerer,
      nftContract,
      nftTokenId,
      priceRaw,
      priceFormatted,
      currencySymbol,
    },
  });

  // If this is a listing (ERC721 offer), check if it was created as a counter-offer
  // by looking for a COUNTER_OFFER intent from the same seller for the same NFT
  if (isListing && nftContract && nftTokenId) {
    const parentOrderHash = await findCounterOfferParent(tx, details.offerer, nftContract, nftTokenId);
    if (parentOrderHash) {
      await tx.order.update({
        where: { chain_orderHash: { chain, orderHash: event.orderHash } },
        data: { parentOrderHash },
      });
      log.info(
        { chain, orderHash: event.orderHash, parentOrderHash },
        "Counter-offer order linked to original bid"
      );
    }
  }

  if (nftContract && nftTokenId) {
    // Collection must be upserted before Token due to FK constraint
    await tx.collection.upsert({
      where: { chain_contractAddress: { chain, contractAddress: nftContract } },
      create: {
        chain,
        contractAddress: nftContract,
        startBlock: event.blockNumber,
      },
      update: {},
    });

    await tx.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress: nftContract, tokenId: nftTokenId } },
      create: {
        chain,
        contractAddress: nftContract,
        tokenId: nftTokenId,
        metadataStatus: "PENDING",
      },
      update: {},
    });
  }

  log.debug(
    { chain, orderHash: event.orderHash, nftContract, nftTokenId },
    "Order created"
  );

  return nftContract;
}

/**
 * For a new ERC721 listing, check if a COUNTER_OFFER intent exists for this
 * seller + NFT coordinates. Returns the original bid's orderHash to set as
 * parentOrderHash, or null if this is a regular listing.
 */
async function findCounterOfferParent(
  tx: Prisma.TransactionClient,
  offerer: string,
  nftContract: string,
  nftTokenId: string
): Promise<string | null> {
  const intents = await tx.transactionIntent.findMany({
    where: {
      type: "COUNTER_OFFER",
      requester: offerer,
      status: { in: ["SIGNED", "CONFIRMED"] },
      parentOrderHash: { not: null },
    },
    select: { parentOrderHash: true },
  });
  if (!intents.length) return null;

  const parentHashes = intents.map((i) => i.parentOrderHash!);
  const originalOrder = await tx.order.findFirst({
    where: { orderHash: { in: parentHashes }, nftContract, nftTokenId },
    select: { orderHash: true },
  });
  return originalOrder?.orderHash ?? null;
}

function parseOrderDetails(raw: any): OnChainOrderDetails {
  // starknet.js v6 CairoCustomEnum — use activeVariant() to get the live variant name
  const statusVariant: string =
    typeof raw.order_status?.activeVariant === "function"
      ? raw.order_status.activeVariant()
      : "";
  let status: "active" | "fulfilled" | "cancelled" = "active";
  if (statusVariant === "Filled") status = "fulfilled";
  if (statusVariant === "Cancelled") status = "cancelled";

  // starknet.js v6 CairoOption — .Some is undefined (not absent) for None variants
  const fulfillerOption = raw.fulfiller;
  let fulfiller: string | null = null;
  const fulfillerSome: unknown =
    typeof fulfillerOption?.isSome === "function"
      ? fulfillerOption.isSome()
        ? fulfillerOption.unwrap()
        : undefined
      : fulfillerOption?.Some;
  if (fulfillerSome !== undefined && fulfillerSome !== null) {
    fulfiller = normalizeAddress(String(fulfillerSome));
  }

  return {
    offerer: normalizeAddress(raw.offerer.toString()),
    offerItemType: decodeShortstring(raw.offer.item_type),
    offerToken: normalizeAddress(raw.offer.token.toString()),
    offerIdentifier: raw.offer.identifier_or_criteria.toString(),
    offerStartAmount: raw.offer.start_amount.toString(),
    offerEndAmount: raw.offer.end_amount.toString(),
    considerationItemType: decodeShortstring(raw.consideration.item_type),
    considerationToken: normalizeAddress(raw.consideration.token.toString()),
    considerationIdentifier: raw.consideration.identifier_or_criteria.toString(),
    considerationStartAmount: raw.consideration.start_amount.toString(),
    considerationEndAmount: raw.consideration.end_amount.toString(),
    considerationRecipient: normalizeAddress(raw.consideration.recipient.toString()),
    startTime: BigInt(raw.start_time.toString()),
    endTime: BigInt(raw.end_time.toString()),
    status,
    fulfiller,
  };
}

/** Decode a Cairo felt252 short string into its ASCII representation. */
function decodeShortstring(felt: unknown): string {
  try {
    let n = BigInt(String(felt));
    const bytes: number[] = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    return Buffer.from(bytes).toString("ascii");
  } catch {
    return String(felt);
  }
}
