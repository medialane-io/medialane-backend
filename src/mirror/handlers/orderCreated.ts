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
    details.offerItemType === "ERC721" || details.offerItemType === "ERC1155"
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
    // Collection must be upserted before Token due to FK constraint
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
  }

  log.debug(
    { chain, orderHash: event.orderHash, nftContract, nftTokenId },
    "Order created"
  );
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
