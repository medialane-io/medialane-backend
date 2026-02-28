import { Contract } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import { IPMarketplaceABI } from "../../config/abis.js";
import { MARKETPLACE_CONTRACT } from "../../config/constants.js";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import { getTokenByAddress } from "../../config/constants.js";
import { formatAmount } from "../../utils/bigint.js";
import type { ParsedOrderCreated, OnChainOrderDetails } from "../../types/marketplace.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:orderCreated");

export async function handleOrderCreated(
  event: ParsedOrderCreated,
  tx: Prisma.TransactionClient,
  chain: Chain
): Promise<void> {
  const provider = createProvider();
  const contract = new Contract(
    IPMarketplaceABI as any,
    MARKETPLACE_CONTRACT,
    provider
  );

  let details: OnChainOrderDetails;
  try {
    const raw = await contract.get_order_details(event.orderHash);
    details = parseOrderDetails(raw);
  } catch (err) {
    log.error(
      { err, orderHash: event.orderHash },
      "Failed to fetch order details from RPC"
    );
    return;
  }

  const token = getTokenByAddress(details.considerationToken);
  const priceRaw = details.considerationStartAmount;
  const priceFormatted = token ? formatAmount(priceRaw, token.decimals) : priceRaw;
  const currencySymbol = token?.symbol ?? null;

  const nftContract =
    details.offerItemType === 2 || details.offerItemType === 3
      ? details.offerToken
      : null;
  const nftTokenId = nftContract ? details.offerIdentifier : null;

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

  if (nftContract && nftTokenId) {
    await tx.token.upsert({
      where: { chain_contractAddress_tokenId: { chain, contractAddress: nftContract, tokenId: nftTokenId } },
      create: {
        chain,
        contractAddress: nftContract,
        tokenId: nftTokenId,
        owner: details.offerer,
        metadataStatus: "PENDING",
      },
      update: {},
    });

    await tx.collection.upsert({
      where: { chain_contractAddress: { chain, contractAddress: nftContract } },
      create: {
        chain,
        contractAddress: nftContract,
        startBlock: event.blockNumber,
        isKnown: false,
      },
      update: {},
    });
  }

  log.debug(
    { chain, orderHash: event.orderHash, nftContract, nftTokenId },
    "Order created"
  );
}

function parseOrderDetails(raw: any): OnChainOrderDetails {
  const statusKey = Object.keys(raw.order_status)[0];
  let status: "active" | "fulfilled" | "cancelled" = "active";
  if (statusKey === "Filled") status = "fulfilled";
  if (statusKey === "Cancelled") status = "cancelled";

  const fulfillerOption = raw.fulfiller;
  let fulfiller: string | null = null;
  if (fulfillerOption && typeof fulfillerOption === "object") {
    const key = Object.keys(fulfillerOption)[0];
    if (key === "Some") {
      fulfiller = normalizeAddress(fulfillerOption.Some.toString());
    }
  }

  return {
    offerer: normalizeAddress(raw.offerer.toString()),
    offerItemType: Number(raw.offer.item_type),
    offerToken: normalizeAddress(raw.offer.token.toString()),
    offerIdentifier: raw.offer.identifier_or_criteria.toString(),
    offerStartAmount: raw.offer.start_amount.toString(),
    offerEndAmount: raw.offer.end_amount.toString(),
    considerationItemType: Number(raw.consideration.item_type),
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
