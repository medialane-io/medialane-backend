

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

  const calls = [
    {
      contractAddress: body.nftContract,
      entrypoint: "set_approval_for_all",
      calldata: [STARKNET_MARKETPLACE_1155_CONTRACT, "0x1"],
    },
    {
      contractAddress: STARKNET_MARKETPLACE_1155_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

async function buildCreateListing721Intent(body: CreateListingIntentBody) {
  const token = getTokenByAddress(body.currency);
  if (!token) throw new Error(`Unsupported currency: ${body.currency}`);
  const priceWei = parseAmount(body.price, token.decimals);
  const chainId = getChainId();
  const salt = body.salt ?? generateSalt();
  const counter = await fetchCounter(body.offerer);
  const royaltyMaxBps = await fetchRoyaltyMaxBps(body.nftContract, body.tokenId);

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

  return { calls };
}

export async function buildCancelOrderIntent(body: CancelOrderIntentBody) {
  const chainId = getChainId();

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
