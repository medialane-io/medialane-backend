import { describe, expect, test } from "bun:test";
import { collectionSchema, orderSchema, tokenSchema } from "@medialane/sdk/contract";
import { z } from "zod";
import { serializeCollection, serializeOrder, serializeToken } from "./serialize.js";

function deepStrict(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, deepStrict(value as z.ZodTypeAny)]));
    return z.object(shape).strict();
  }
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element));
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap()).nullable();
  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap()).optional();
  return schema;
}

const onTheWire = (value: unknown) => JSON.parse(JSON.stringify(value));
const conforms = (schema: z.ZodTypeAny, value: unknown) => {
  const result = deepStrict(schema).safeParse(onTheWire(value));
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
};

const now = new Date("2026-01-02T03:04:05.000Z");

const orderRow = {
  id: "o1",
  chain: "STARKNET",
  orderHash: "0xabc",
  parentOrderHash: null,
  offerer: "0x1",
  offerItemType: "ERC721",
  offerToken: "0x2",
  offerIdentifier: "7",
  offerStartAmount: "1",
  offerEndAmount: "1",
  considerationItemType: "ERC20",
  considerationToken: "0x3",
  considerationIdentifier: "0",
  considerationStartAmount: "1000000",
  considerationEndAmount: "1000000",
  considerationRecipient: "0x1",
  startTime: 100n,
  endTime: 200n,
  status: "ACTIVE",
  fulfiller: null,
  nftContract: "0x2",
  nftTokenId: "7",
  priceRaw: "1000000",
  priceFormatted: "1.0",
  currencySymbol: "USDC",
  createdTxHash: "0xt1",
  fulfilledTxHash: null,
  cancelledTxHash: null,
  createdBlockNumber: 55n,
  remainingAmount: null,
  createdAt: now,
  updatedAt: now,
} as never;

const tokenRow = {
  id: "t1",
  chain: "STARKNET",
  contractAddress: "0x2",
  tokenId: "7",
  tokenUri: "ipfs://cid/7.json",
  metadataStatus: "FETCHED",
  isHidden: false,
  name: "Seven",
  image: "ipfs://cid/7.png",
  animationUrl: null,
  attributes: [{ trait_type: "Edition", value: 7 }, { trait_type: "License", value: "CC BY", display_type: "text" }],
  ipType: "Art",
  licenseType: "CC BY",
  commercialUse: true,
  author: "Ana",
  collection: { standard: "ERC721" },
  owner: "0x9",
  createdAt: now,
  updatedAt: now,
} as never;

const collectionRow = {
  id: "c1",
  chain: "STARKNET",
  contractAddress: "0x2",
  collectionId: "3",
  name: "Gallery",
  symbol: "GAL",
  description: "d",
  image: null,
  attributes: [{ trait_type: "Kind", value: "Art" }],
  owner: "0x1",
  startBlock: 12n,
  metadataStatus: "FETCHED",
  standard: "ERC721",
  isFeatured: false,
  isHidden: false,
  service: "mip-erc721",
  claimedBy: null,
  createdAt: now,
  updatedAt: now,
} as never;

describe("what the serializers send is what the contract documents", () => {
  test("an order", () => {
    conforms(orderSchema, serializeOrder(orderRow));
  });

  test("an order with token data and a counter-offer flag", () => {
    conforms(orderSchema, serializeOrder(orderRow, { name: "Seven", image: null, animationUrl: null }, true));
  });

  test("a fulfilled order", () => {
    conforms(orderSchema, serializeOrder({ ...(orderRow as object), status: "FULFILLED", fulfiller: "0x8", fulfilledTxHash: "0xt2" } as never));
  });

  test("an ERC721 token with an active order and a description", () => {
    conforms(tokenSchema, serializeToken(tokenRow, [orderRow], undefined, { description: "A description", externalUrl: "https://site.test/post" }));
  });

  test("an ERC1155 token with balances", () => {
    conforms(tokenSchema, serializeToken({ ...(tokenRow as object), collection: { standard: "ERC1155" }, owner: null } as never, [], [{ owner: "0x9", amount: "3" }]));
  });

  test("a token whose collection is unknown", () => {
    conforms(tokenSchema, serializeToken({ ...(tokenRow as object), collection: null, attributes: null } as never, []));
  });

  test("a collection with its stats and a profile summary", () => {
    const stats = { floorPrice: "100", totalVolume: "5000", holderCount: 4, totalSupply: 10 };
    const profile = { hasGatedContent: true, gatedContentTitle: "Extras", slug: "gallery", image: null, displayName: "Gallery", description: null };
    conforms(collectionSchema, serializeCollection({ ...(collectionRow as object), profile } as never, stats as never));
  });

  test("a collection with no stats, no profile and a fallback image", () => {
    conforms(collectionSchema, serializeCollection(collectionRow, undefined, "ipfs://cid/1.png"));
  });

  test("the strictness check does refuse an undocumented field", () => {
    const wire = onTheWire(serializeOrder(orderRow));
    expect(deepStrict(orderSchema).safeParse({ ...wire, buyerEmail: "a@b.test" }).success).toBe(false);
    expect(deepStrict(orderSchema).safeParse({ ...wire, offer: { ...wire.offer, note: "x" } }).success).toBe(false);
  });
});
