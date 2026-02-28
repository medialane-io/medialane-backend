// SNIP-12 typed data builders — ported from medialane-dapp/src/lib/hash.ts
import type { TypedData } from "starknet";
import { Contract } from "starknet";
import { createProvider, normalizeAddress } from "../utils/starknet.js";
import { IPMarketplaceABI } from "../config/abis.js";
import { MARKETPLACE_CONTRACT, COLLECTION_CONTRACT, getChainId } from "../config/constants.js";
import type {
  CreateListingIntentBody,
  MakeOfferIntentBody,
  FulfillOrderIntentBody,
  CancelOrderIntentBody,
} from "../types/api.js";
import { ItemType } from "../types/marketplace.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("intent");

// SNIP-12 type definitions
const SNIP12_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "felt" },
    { name: "revision", type: "shortstring" },
  ],
  OfferItem: [
    { name: "item_type", type: "felt" },
    { name: "token", type: "felt" },
    { name: "identifier_or_criteria", type: "felt" },
    { name: "start_amount", type: "felt" },
    { name: "end_amount", type: "felt" },
  ],
  ConsiderationItem: [
    { name: "item_type", type: "felt" },
    { name: "token", type: "felt" },
    { name: "identifier_or_criteria", type: "felt" },
    { name: "start_amount", type: "felt" },
    { name: "end_amount", type: "felt" },
    { name: "recipient", type: "felt" },
  ],
  OrderParameters: [
    { name: "offerer", type: "felt" },
    { name: "offer", type: "OfferItem" },
    { name: "consideration", type: "ConsiderationItem" },
    { name: "start_time", type: "felt" },
    { name: "end_time", type: "felt" },
    { name: "salt", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

const FULFILLMENT_TYPES = {
  ...SNIP12_TYPES,
  OrderFulfillment: [
    { name: "order_hash", type: "felt" },
    { name: "fulfiller", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

const CANCELLATION_TYPES = {
  ...SNIP12_TYPES,
  OrderCancellation: [
    { name: "order_hash", type: "felt" },
    { name: "offerer", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

const DOMAIN = { name: "Medialane", version: "1", revision: "1" };

function toHex(value: string | number | bigint): string {
  if (value === undefined || value === null) return "0x0";
  if (typeof value === "string") {
    if (value.startsWith("0x")) return value;
    try {
      return "0x" + BigInt(value).toString(16);
    } catch {
      return value;
    }
  }
  return "0x" + BigInt(value).toString(16);
}

async function fetchNonce(address: string): Promise<string> {
  const provider = createProvider();
  const contract = new Contract(
    IPMarketplaceABI as any,
    MARKETPLACE_CONTRACT,
    provider
  );
  const nonce = await contract.nonces(normalizeAddress(address));
  return nonce.toString();
}

function generateSalt(): string {
  return "0x" + Math.floor(Math.random() * 0xffffffffffff).toString(16);
}

export async function buildCreateListingIntent(body: CreateListingIntentBody) {
  const nonce = await fetchNonce(body.offerer);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();

  const orderParams = {
    offerer: toHex(body.offerer),
    offer: {
      item_type: toHex(ItemType.ERC721),
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex("1"),
      end_amount: toHex("1"),
    },
    consideration: {
      item_type: toHex(ItemType.ERC20),
      token: toHex(body.currency),
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(body.price),
      end_amount: toHex(body.price),
      recipient: toHex(body.offerer),
    },
    start_time: toHex(Math.floor(Date.now() / 1000)),
    end_time: toHex(body.endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: SNIP12_TYPES,
    primaryType: "OrderParameters",
    domain: { ...DOMAIN, chainId: toHex(chainId) },
    message: orderParams,
  };

  const calls = [
    // approve marketplace to transfer NFT
    {
      contractAddress: body.nftContract,
      entrypoint: "approve",
      calldata: [MARKETPLACE_CONTRACT, body.tokenId, "0"],
    },
    // register_order call (will be built with signature after signing)
    {
      contractAddress: MARKETPLACE_CONTRACT,
      entrypoint: "register_order",
      calldata: [], // populated after signature
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildMakeOfferIntent(body: MakeOfferIntentBody) {
  const nonce = await fetchNonce(body.offerer);
  const salt = body.salt ?? generateSalt();
  const chainId = getChainId();

  const orderParams = {
    offerer: toHex(body.offerer),
    offer: {
      item_type: toHex(ItemType.ERC20),
      token: toHex(body.currency),
      identifier_or_criteria: toHex("0"),
      start_amount: toHex(body.price),
      end_amount: toHex(body.price),
    },
    consideration: {
      item_type: toHex(ItemType.ERC721),
      token: toHex(body.nftContract),
      identifier_or_criteria: toHex(body.tokenId),
      start_amount: toHex("1"),
      end_amount: toHex("1"),
      recipient: toHex(body.offerer),
    },
    start_time: toHex(Math.floor(Date.now() / 1000)),
    end_time: toHex(body.endTime),
    salt: toHex(salt),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: SNIP12_TYPES,
    primaryType: "OrderParameters",
    domain: { ...DOMAIN, chainId: toHex(chainId) },
    message: orderParams,
  };

  const calls = [
    // approve marketplace to spend ERC20
    {
      contractAddress: body.currency,
      entrypoint: "approve",
      calldata: [MARKETPLACE_CONTRACT, body.price, "0"],
    },
    {
      contractAddress: MARKETPLACE_CONTRACT,
      entrypoint: "register_order",
      calldata: [],
    },
  ];

  return { typedData, calls, orderParams };
}

export async function buildFulfillOrderIntent(body: FulfillOrderIntentBody) {
  const nonce = await fetchNonce(body.fulfiller);
  const chainId = getChainId();

  const fulfillment = {
    order_hash: toHex(body.orderHash),
    fulfiller: toHex(body.fulfiller),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: FULFILLMENT_TYPES,
    primaryType: "OrderFulfillment",
    domain: { ...DOMAIN, chainId: toHex(chainId) },
    message: fulfillment,
  };

  // Fetch order to know what currency to approve
  const order = await prisma.order.findUnique({
    where: { chain_orderHash: { chain: "STARKNET", orderHash: body.orderHash } },
  });

  const calls: any[] = [];

  if (order?.considerationToken && order?.considerationStartAmount) {
    calls.push({
      contractAddress: order.considerationToken,
      entrypoint: "approve",
      calldata: [MARKETPLACE_CONTRACT, order.considerationStartAmount, "0"],
    });
  }

  calls.push({
    contractAddress: MARKETPLACE_CONTRACT,
    entrypoint: "fulfill_order",
    calldata: [],
  });

  return { typedData, calls, fulfillment };
}

export async function buildCancelOrderIntent(body: CancelOrderIntentBody) {
  const nonce = await fetchNonce(body.offerer);
  const chainId = getChainId();

  const cancelation = {
    order_hash: toHex(body.orderHash),
    offerer: toHex(body.offerer),
    nonce: toHex(nonce),
  };

  const typedData: TypedData = {
    types: CANCELLATION_TYPES,
    primaryType: "OrderCancellation",
    domain: { ...DOMAIN, chainId: toHex(chainId) },
    message: cancelation,
  };

  const calls = [
    {
      contractAddress: MARKETPLACE_CONTRACT,
      entrypoint: "cancel_order",
      calldata: [],
    },
  ];

  return { typedData, calls, cancelation };
}
