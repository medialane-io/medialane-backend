// Marketplace order intents: listing, offer, fulfill, cancel, counter-offer.
// SNIP-12 typed-data shapes live in @medialane/sdk (src/marketplace/signing.ts)
// — the protocol's single source of truth. The 2026-04-28 V2 incident was
// caused by two divergent copies; never re-declare these shapes here.
import type { TypedData } from "starknet";
import { cairo } from "starknet";
import {
  STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT,
  getChainId, getTokenByAddress,
} from "../../config/constants.js";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
} from "@medialane/sdk/starknet";
import type {
  CreateListingIntentBody,
  MakeOfferIntentBody,
  FulfillOrderIntentBody,
  CancelOrderIntentBody,
  CounterOfferIntentBody,
} from "../../types/api.js";
import prisma from "../../db/client.js";
import { buildOrderParams, fetchCounter, fetchCounter1155, fetchRoyaltyMaxBps, generateSalt, parseAmount, toHex } from "./shared.js";

/** Build a CREATE_LISTING intent for an ERC-1155 token. */
async function buildCreateListing1155Intent(body: CreateListingIntentBody & { amount: string }) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);
  const chainId = getChainId();
  const salt = body.salt ?? generateSalt();

  const amount = BigInt(body.amount);
  if (amount < 1n) throw new Error("amount must be at least 1");
  const counter = await fetchCounter1155(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);

  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: STARKNET_MARKETPLACE_1155_CONTRACT,
    offer: { itemType: "ERC1155", token: body.nftContract, identifierOrCriteria: body.tokenId, amount },
    consideration: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei, recipient: body.offerer },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = build1155OrderTypedData(orderParams, chainId);

  // set_approval_for_all(marketplace_1155, true) + register_order(flat_order, signature)
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "set_approval_for_all",
      calldata: [STARKNET_MARKETPLACE_1155_CONTRACT, "0x1"],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_1155_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated after signature
    },
  ];

  return { typedData, calls, orderParams };
}

/** Build a CREATE_LISTING intent for an ERC-721 token. */
async function buildCreateListing721Intent(body: CreateListingIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);
  const chainId = getChainId();
  const salt = body.salt ?? generateSalt();
  const counter = await fetchCounter(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);

  // 30s buffer on start_time — enough for tx inclusion on Starknet (~6s blocks)
  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: STARKNET_MARKETPLACE_721_CONTRACT,
    offer: { itemType: "ERC721", token: body.nftContract, identifierOrCriteria: body.tokenId, amount: "1" },
    consideration: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei, recipient: body.offerer },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = buildOrderTypedData(orderParams, chainId);

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [STARKNET_MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_721_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated after signature
    },
  ];

  return { typedData, calls, orderParams };
}

/** Dispatch to the correct listing intent builder based on token standard.
 *  Presence of `amount` indicates ERC-1155; absence means ERC-721. */
export async function buildCreateListingIntent(body: CreateListingIntentBody) {
  return body.amount != null
    ? buildCreateListing1155Intent({ ...body, amount: body.amount })
    : buildCreateListing721Intent(body);
}

export async function buildMakeOfferIntent(body: MakeOfferIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);

  const is1155 = body.tokenStandard === "ERC1155";
  const counter = is1155 ? await fetchCounter1155(body.offerer) : await fetchCounter(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;
  const quantity = is1155 ? BigInt(body.quantity ?? "1") : 1n;
  if (quantity < 1n) throw new Error("quantity must be at least 1");

  // 30s buffer on start_time — enough for tx inclusion on Starknet (~6s blocks)
  const orderParams = buildOrderParams({
    offerer: body.offerer,
    marketplace: marketplaceContract,
    offer: { itemType: "ERC20", token: body.currency, identifierOrCriteria: "0", amount: priceWei },
    consideration: {
      itemType: is1155 ? "ERC1155" : "ERC721",
      token: body.nftContract,
      identifierOrCriteria: body.tokenId,
      amount: quantity,
      recipient: body.offerer,
    },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime: body.endTime,
    salt,
    counter,
  });

  const typedData: TypedData = is1155
    ? build1155OrderTypedData(orderParams, chainId)
    : buildOrderTypedData(orderParams, chainId);

  // approve(marketplace, amount as u256)
  const priceUint256 = cairo.uint256(priceWei);
  const calls = [
    {
      contractAddress: body.currency,
      entrypoint: "approve",
      calldata: [marketplaceContract, priceUint256.low.toString(), priceUint256.high.toString()],
    },
    {
      contractAddress: marketplaceContract,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody) {
  // Fetch order to determine ERC-721 vs ERC-1155 contract routing.
  // tokenStandard hint from the caller takes precedence — used when the order
  // is not yet in the DB (e.g. listing was created before the indexer caught up).
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const is1155 =
    body.tokenStandard === "ERC1155" ||
    order?.offerItemType === "ERC1155" ||
    order?.considerationItemType === "ERC1155";
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;

  // Fulfilment is unsigned — the caller IS the fulfiller (audit F3). No SNIP-12,
  // no nonce. For ERC-1155 the buyer's chosen unit quantity defaults to 1.
  const quantity1155 = is1155 ? BigInt(body.quantity ?? "1") : 1n;

  const calls: { contractAddress: string; entrypoint: string; calldata: string[] }[] = [];

  const offerItemType = order?.offerItemType;
  const considerationItemType = order?.considerationItemType;
  const isListing = offerItemType === "ERC721" || offerItemType === "ERC1155";
  const isOffer = considerationItemType === "ERC721" || considerationItemType === "ERC1155";

  if (isListing && order?.considerationToken && order?.considerationStartAmount) {
    // Buyer fulfills a listing: approve payment token for price_per_unit × quantity.
    // No fee is bundled here — the platform fee is charged by io as a separate
    // post-confirmation transaction (this originated with a prior non-atomic
    // relayer account, where a bundled fee would stick even when fulfill_order
    // reverts — io's account is atomic now, revisit whether this still needs
    // to be separate). See
    // medialane-core/docs/specs/2026-05-20-io-verify-then-charge-fee-design.md
    const pricePerUnit = BigInt(order.considerationStartAmount);
    const totalPrice = (pricePerUnit * quantity1155).toString();
    const amountUint256 = cairo.uint256(totalPrice);
    calls.push({
      contractAddress: order.considerationToken,
      entrypoint: "approve",
      calldata: [marketplaceContract, amountUint256.low.toString(), amountUint256.high.toString()],
    });
  } else if (isOffer && order?.considerationToken && order?.considerationIdentifier) {
    // Seller accepts an offer: approve the NFT side to the marketplace.
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
    // 721: fulfill_order(order_hash); 1155: fulfill_order(order_hash, quantity)
    calldata: is1155
      ? [toHex(body.orderHash), toHex(quantity1155)]
      : [toHex(body.orderHash)],
  });

  return { calls };
}

export async function buildCancelOrderIntent(body: CancelOrderIntentBody) {
  const chainId = getChainId();

  // Fetch order to determine ERC-721 vs ERC-1155 contract routing.
  // tokenStandard hint takes precedence over DB lookup (same as fulfillment).
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const is1155 =
    body.tokenStandard === "ERC1155" ||
    order?.offerItemType === "ERC1155" ||
    order?.considerationItemType === "ERC1155";
  const marketplaceContract = is1155 ? STARKNET_MARKETPLACE_1155_CONTRACT : STARKNET_MARKETPLACE_721_CONTRACT;

  const cancelation = {
    order_hash: toHex(body.orderHash),
    offerer: toHex(body.offerer),
  };

  const typedData: TypedData = is1155
    ? build1155CancellationTypedData(cancelation, chainId)
    : buildCancellationTypedData(cancelation, chainId);

  const calls = [
    {
      contractAddress: marketplaceContract,
      entrypoint: "cancel_order",
      calldata: [] as string[],
    },
  ];

  return { typedData, calls, cancelation };
}

/**
 * Build a COUNTER_OFFER intent — a standard ERC721 listing where the seller
 * responds to a buyer's bid with a specific counter price.
 *
 * Key difference from buildCreateListingIntent: priceRaw is already in raw wei
 * (not human-readable), and the currency comes from the original bid's offerToken.
 */
export async function buildCounterOfferIntent(body: CounterOfferIntentBody) {
  const counter = await fetchCounter(body.sellerAddress);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();
  const priceWei = BigInt(body.priceRaw);
  const endTime = Math.floor(Date.now() / 1000) + body.durationSeconds;

  const orderParams = buildOrderParams({
    offerer: body.sellerAddress,
    marketplace: STARKNET_MARKETPLACE_721_CONTRACT,
    offer: { itemType: "ERC721", token: body.nftContract, identifierOrCriteria: body.tokenId, amount: "1" },
    consideration: { itemType: "ERC20", token: body.currencyAddress, identifierOrCriteria: "0", amount: priceWei, recipient: body.sellerAddress },
    royaltyMaxBps,
    startTime: Math.floor(Date.now() / 1000) + 30,
    endTime,
    salt,
    counter,
  });

  const typedData: TypedData = buildOrderTypedData(orderParams, chainId);

  // approve(marketplace, tokenId as u256)
  const tokenIdUint256 = cairo.uint256(body.tokenId);
  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [STARKNET_MARKETPLACE_721_CONTRACT, tokenIdUint256.low.toString(), tokenIdUint256.high.toString()],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_721_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}
