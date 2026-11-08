import {
  buildIntent,
  resolveIntentInputs,
  ORDER_START_DELAY_SECONDS,
  ORDER_START_WINDOW_SECONDS,
  type CancelIntentParams,
  type CounterOfferIntentParams,
  type FulfillInputs,
  type IntentReaders,
  type ListingIntentParams,
  type OfferIntentParams,
} from "@medialane/sdk/starknet";
import { appFeeConfig, type IntentBuildContext } from "./fee.js";
import { sdkConfig } from "./sdkConfig.js";
import type { FulfillOrderIntentBody } from "../../types/intents.js";
import prisma from "../../db/client.js";
import { readOwnership } from "../../chainRead/ownership.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { IntentRefusal } from "./refusal.js";
import { fetchCounter, fetchCounter1155, fetchRoyaltyMaxBps, generateSalt } from "./shared.js";


type OrderTimingRequest = { salt?: string; startTime?: number };
type ListingIntentRequest = Omit<ListingIntentParams, "salt" | "startTime"> & OrderTimingRequest;
type OfferIntentRequest = Omit<OfferIntentParams, "salt" | "startTime"> & OrderTimingRequest;
type CounterOfferIntentRequest = Omit<CounterOfferIntentParams, "salt" | "startTime"> & OrderTimingRequest;

export const orderReaders: IntentReaders = {
  counterOf: (offerer, standard) => (standard === "ERC1155" ? fetchCounter1155(offerer) : fetchCounter(offerer)),
  royaltyCapOf: fetchRoyaltyMaxBps,
  async orderOf(orderHash) {
    const o = await prisma.order.findUnique({ where: { chain_orderHash: { chain: "STARKNET", orderHash } } });
    if (!o) return null;
    return {
      offer: { itemType: o.offerItemType, token: o.offerToken, identifier: o.offerIdentifier, startAmount: o.offerStartAmount, endAmount: o.offerEndAmount },
      consideration: {
        itemType: o.considerationItemType,
        token: o.considerationToken,
        identifier: o.considerationIdentifier,
        startAmount: o.considerationStartAmount,
        endAmount: o.considerationEndAmount,
        recipient: o.considerationRecipient,
      },
    };
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

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody, ctx: IntentBuildContext = { appId: "" }) {
  const inputs = (await resolveIntentInputs("fulfill", body, orderReaders)) as FulfillInputs;
  await assertSellerStillHolds(body, inputs.is1155);
  return buildIntent("fulfill", body, inputs, { ...sdkConfig, feeConfig: appFeeConfig(ctx.appId) });
}

async function assertSellerStillHolds(body: FulfillOrderIntentBody, is1155: boolean): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
    select: { offerItemType: true, offerer: true, nftContract: true, nftTokenId: true },
  });
  const isListing = order?.offerItemType === "ERC721" || order?.offerItemType === "ERC1155";
  if (!isListing || !order?.nftContract || !order.nftTokenId) return;
  const owner = normalizeAddress("STARKNET", order.offerer);
  const quantity = is1155 ? BigInt(body.quantity ?? "1") : 1n;
  const [held] = await readOwnership([
    is1155
      ? { standard: "ERC1155", contractAddress: order.nftContract, tokenId: order.nftTokenId, owner }
      : { standard: "ERC721", contractAddress: order.nftContract, tokenId: order.nftTokenId },
  ]);
  if (held?.standard === "ERC1155") {
    if (held.amount === 0n) throw new IntentRefusal(SELLER_NO_LONGER_OWNS);
    if (held.amount < quantity) throw new IntentRefusal(SELLER_LACKS_QUANTITY);
  } else if (held?.owner !== owner) {
    throw new IntentRefusal(SELLER_NO_LONGER_OWNS);
  }
}

export async function buildCancelOrderIntent(body: CancelIntentParams) {
  return buildIntent("cancel", body, await resolveIntentInputs("cancel", body, orderReaders), sdkConfig);
}

export async function buildCounterOfferIntent(body: CounterOfferIntentRequest) {
  const params = withOrderTiming(body);
  return buildIntent("counter-offer", params, await resolveIntentInputs("counter-offer", params, orderReaders), sdkConfig);
}
