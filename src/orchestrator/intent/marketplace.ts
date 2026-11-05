import { cairo } from "starknet";
import { resolveConfig, type ResolvedFeeConfig } from "@medialane/sdk";
import {
  buildIntent,
  resolveIntentInputs,
  ORDER_START_DELAY_SECONDS,
  ORDER_START_WINDOW_SECONDS,
  type CancelIntentParams,
  type CounterOfferIntentParams,
  type IntentReaders,
  type ListingIntentParams,
  type OfferIntentParams,
} from "@medialane/sdk/starknet";
import { platformFeeCalls, platformFeeConfig, type IntentBuildContext } from "./fee.js";
import {
  STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT,
} from "../../config/constants.js";
import type { FulfillOrderIntentBody } from "../../types/intents.js";
import prisma from "../../db/client.js";
import { serializeOrder } from "../../api/utils/serialize.js";
import { readOwnership } from "../../chainRead/ownership.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { IntentRefusal } from "./refusal.js";
import { fetchCounter, fetchCounter1155, fetchRoyaltyMaxBps, generateSalt, toHex } from "./shared.js";

const sdkConfig = resolveConfig({});

type OrderTimingRequest = { salt?: string; startTime?: number };
type ListingIntentRequest = Omit<ListingIntentParams, "salt" | "startTime"> & OrderTimingRequest;
type OfferIntentRequest = Omit<OfferIntentParams, "salt" | "startTime"> & OrderTimingRequest;
type CounterOfferIntentRequest = Omit<CounterOfferIntentParams, "salt" | "startTime"> & OrderTimingRequest;

export const orderReaders: IntentReaders = {
  counterOf: (offerer, standard) => (standard === "ERC1155" ? fetchCounter1155(offerer) : fetchCounter(offerer)),
  royaltyCapOf: fetchRoyaltyMaxBps,
  async orderOf(orderHash) {
    const order = await prisma.order.findUnique({ where: { chain_orderHash: { chain: "STARKNET", orderHash } } });
    return order ? serializeOrder(order) : null;
  },
};

export function withOrderTiming<P extends OrderTimingRequest>(request: P): P & { salt: string; startTime: number } {
  const now = Math.floor(Date.now() / 1000);
  if (request.startTime !== undefined && Math.abs(request.startTime - now) > ORDER_START_WINDOW_SECONDS) {
    throw new IntentRefusal("The order's start time is out of range");
  }
  return { ...request, salt: request.salt ?? generateSalt(), startTime: request.startTime ?? now + ORDER_START_DELAY_SECONDS };
}

const SELLER_NO_LONGER_OWNS = "This listing is no longer available because the seller no longer owns this item.";
const SELLER_LACKS_QUANTITY = "The seller no longer has enough of this item to complete this purchase.";

export async function buildCreateListingIntent(body: ListingIntentRequest) {
  const params = withOrderTiming(body);
  return buildIntent("listing", params, await resolveIntentInputs("listing", params, orderReaders), sdkConfig);
}

export async function buildMakeOfferIntent(body: OfferIntentRequest) {
  const params = withOrderTiming(body);
  return buildIntent("offer", params, await resolveIntentInputs("offer", params, orderReaders), sdkConfig);
}

export function fulfillFeeCalls(
  order: { offerItemType: string | null; considerationItemType: string | null; considerationToken: string | null; considerationStartAmount: string | null } | null,
  quantity: bigint,
  ctx: IntentBuildContext,
  cfg: ResolvedFeeConfig = platformFeeConfig,
) {
  const isListing = order?.offerItemType === "ERC721" || order?.offerItemType === "ERC1155";
  if (!isListing || !order?.considerationToken || !order.considerationStartAmount) return [];
  return platformFeeCalls(ctx.appId, "marketplace", order.considerationToken, BigInt(order.considerationStartAmount) * quantity, cfg);
}

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody, ctx: IntentBuildContext = { appId: "" }) {

  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const is1155 =
    body.tokenStandard === "ERC1155" ||
    order?.offerItemType === "ERC1155" ||
    order?.considerationItemType === "ERC1155";
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;

  const quantity1155 = is1155 ? BigInt(body.quantity ?? "1") : 1n;

  const calls: { contractAddress: string; entrypoint: string; calldata: string[] }[] = [];

  const offerItemType = order?.offerItemType;
  const considerationItemType = order?.considerationItemType;
  const isListing = offerItemType === "ERC721" || offerItemType === "ERC1155";
  const isOffer = considerationItemType === "ERC721" || considerationItemType === "ERC1155";

  if (isListing && order?.nftContract && order.nftTokenId) {
    const owner = normalizeAddress("STARKNET", order.offerer);
    const [held] = await readOwnership([
      is1155
        ? { standard: "ERC1155", contractAddress: order.nftContract, tokenId: order.nftTokenId, owner }
        : { standard: "ERC721", contractAddress: order.nftContract, tokenId: order.nftTokenId },
    ]);
    if (held?.standard === "ERC1155") {
      if (held.amount === 0n) throw new IntentRefusal(SELLER_NO_LONGER_OWNS);
      if (held.amount < quantity1155) throw new IntentRefusal(SELLER_LACKS_QUANTITY);
    } else if (held?.owner !== owner) {
      throw new IntentRefusal(SELLER_NO_LONGER_OWNS);
    }
  }

  if (isListing && order?.considerationToken && order?.considerationStartAmount) {

    const pricePerUnit = BigInt(order.considerationStartAmount);
    const totalPrice = (pricePerUnit * quantity1155).toString();
    const amountUint256 = cairo.uint256(totalPrice);
    calls.push({
      contractAddress: order.considerationToken,
      entrypoint: "approve",
      calldata: [marketplaceContract, amountUint256.low.toString(), amountUint256.high.toString()],
    });
  } else if (isOffer && order?.considerationToken && order?.considerationIdentifier) {

    if (is1155 || considerationItemType === "ERC1155") {
      calls.push({
        contractAddress: order.considerationToken,
        entrypoint: "set_approval_for_all",
        calldata: [marketplaceContract, "0x1"],
      });
    } else {
      const tokenIdUint256 = cairo.uint256(order.considerationIdentifier);
      calls.push({
        contractAddress: order.considerationToken,
        entrypoint: "approve",
        calldata: [marketplaceContract, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
      });
    }
  }

  calls.push({
    contractAddress: marketplaceContract,
    entrypoint: "fulfill_order",

    calldata: is1155
      ? [toHex(body.orderHash), toHex(quantity1155)]
      : [toHex(body.orderHash)],
  });

  calls.push(...fulfillFeeCalls(order, quantity1155, ctx));

  return { calls };
}

export async function buildCancelOrderIntent(body: CancelIntentParams) {
  return buildIntent("cancel", body, await resolveIntentInputs("cancel", body, orderReaders), sdkConfig);
}

export async function buildCounterOfferIntent(body: CounterOfferIntentRequest) {
  const params = withOrderTiming(body);
  return buildIntent("counter-offer", params, await resolveIntentInputs("counter-offer", params, orderReaders), sdkConfig);
}
