import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { resolveConfig } from "@medialane/sdk";
import { buildIntent, ORDER_START_WINDOW_SECONDS } from "@medialane/sdk/starknet";
import * as starknetUtils from "../../../utils/starknet.js";
import * as realX402 from "../../../config/x402.js";
import type { AppEnv } from "../../../types/hono.js";

const provider = {
  callContract: async ({ entrypoint }: { entrypoint: string }) => (entrypoint === "get_counter" ? ["0x5"] : ["0x0", "0x1f4"]),
};
mock.module("../../../utils/starknet.js", () => ({ ...starknetUtils, callRpc: (fn: (p: unknown) => unknown) => fn(provider) }));
const FUND = "0x064c51746dbcb7498cc6e4b8abfcacd60805c0762b0411bb0515c611b5ae8223";
mock.module("../../../config/x402.js", () => ({ ...realX402, x402Config: { ...realX402.x402Config, treasury: FUND } }));
mock.module("../../../chainRead/ownership.js", () => ({
  readOwnership: async (keys: Array<{ standard: string }>) =>
    keys.map((k) => (k.standard === "ERC1155" ? { standard: "ERC1155", amount: 10n } : { standard: "ERC721", owner: ME })),
}));

const ME = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NFT = "0x0222222222222222222222222222222222222222222222222222222222222222";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ORIGINAL = "0x0777777777777777777777777777777777777777777777777777777777777777";
const now = () => Math.floor(Date.now() / 1000);

const offerOnMyNft = {
  id: "o1", chain: "STARKNET", orderHash: ORIGINAL, parentOrderHash: null, offerer: "0x9",
  offerItemType: "ERC20", offerToken: STRK, offerIdentifier: "0", offerStartAmount: "1", offerEndAmount: "1",
  considerationItemType: "ERC721", considerationToken: NFT, considerationIdentifier: "42",
  considerationStartAmount: "1", considerationEndAmount: "1", considerationRecipient: ME,
  startTime: 100n, endTime: 9_999_999_999n, status: "ACTIVE", fulfiller: null, nftContract: NFT, nftTokenId: "42",
  priceRaw: "1", priceFormatted: "0.000000000000000001", currencySymbol: "STRK", createdTxHash: "0xt1",
  fulfilledTxHash: null, cancelledTxHash: null, createdBlockNumber: 1n, remainingAmount: null,
  createdAt: new Date(), updatedAt: new Date(),
};

const myListing = {
  ...offerOnMyNft, offerer: ME, offerItemType: "ERC721", offerToken: NFT, offerIdentifier: "42",
  considerationItemType: "ERC20", considerationToken: STRK, considerationIdentifier: "0",
  considerationStartAmount: "1500000000000000000", considerationRecipient: ME,
};

let created: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = offerOnMyNft;
const db = {
  order: {
    findUnique: async () => stored,
    findFirst: async (args: { where: Record<string, unknown> }) => ("parentOrderHash" in args.where ? null : stored),
    findMany: async () => [{ orderHash: ORIGINAL }],
  },
  transactionIntent: {
    create: async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: `intent-${created.length}`, ...data }),
    createManyAndReturn: async ({ data }: { data: Array<Record<string, unknown>> }) =>
      data.map((d) => (created.push(d), { id: `intent-${created.length}`, orderHash: d.orderHash })),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};
mock.module("../../../db/client.js", () => ({ default: db }));

const { registerBuildRoutes } = await import("./build.js");

function app(appId?: string) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "acct", status: "ACTIVE" } as never);
    if (appId) c.set("appId" as never, appId as never);
    await next();
  });
  registerBuildRoutes(a);
  return a;
}

const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const config = resolveConfig({});
const inputs = { counter: "5", royaltyMaxBps: "500" };
const listing = () => ({ offerer: ME, nftContract: NFT, tokenId: "42", currency: STRK, price: "1.5", endTime: 1_900_000_000, salt: "0xabc", startTime: now() + 30 });

beforeEach(() => {
  created = [];
  stored = offerOnMyNft;
});

describe("an order the client built", () => {
  test("a listing built by the client is recorded when it matches", async () => {
    const params = listing();
    const built = buildIntent("listing", params, inputs, config);
    const res = await app().request("/listing", post({ ...params, built }));
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("a listing built by the client at another price is refused with intent_mismatch", async () => {
    const params = listing();
    const built = buildIntent("listing", { ...params, price: "1.6" }, inputs, config);
    const res = await app().request("/listing", post({ ...params, built }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "intent_mismatch" });
    expect(created).toHaveLength(0);
  });

  test("a listing whose build adds a call is refused", async () => {
    const params = listing();
    const built = buildIntent("listing", params, inputs, config);
    const extra = { contractAddress: STRK, entrypoint: "transfer", calldata: [ME, "1", "0"] };
    const res = await app().request("/listing", post({ ...params, built: { ...built, calls: [...built.calls, extra] } }));
    expect(res.status).toBe(422);
  });

  test("a start time outside the window is refused", async () => {
    const params = { ...listing(), startTime: now() + ORDER_START_WINDOW_SECONDS + 600 };
    const res = await app().request("/listing", post(params));
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  test("a listing without built is built by the server as before", async () => {
    const { startTime: _ignored, ...params } = listing();
    const res = await app().request("/listing", post(params));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { typedData: { message: { start_time: string; salt: string } } } };
    expect(Number(body.data.typedData.message.start_time)).toBeGreaterThan(now());
    expect(BigInt(body.data.typedData.message.salt)).toBe(0xabcn);
  });

  test("a cancel built by the client is recorded when it matches", async () => {
    const params = { offerer: ME, orderHash: ORIGINAL, tokenStandard: "ERC721" as const };
    const built = buildIntent("cancel", params, { is1155: false }, config);
    const res = await app().request("/cancel", post({ ...params, built }));
    expect(res.status).toBe(201);
  });

  test("a counter-offer built by the client is recorded when it matches", async () => {
    const params = { sellerAddress: ME, originalOrderHash: ORIGINAL, durationSeconds: 86_400, priceRaw: "2000000000000000000", salt: "0xdef", startTime: now() + 30 };
    const built = buildIntent("counter-offer", params, { nftContract: NFT, tokenId: "42", currency: STRK, ...inputs }, config);
    const res = await app().request("/counter-offer", post({ ...params, built }));
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  test("a counter-offer built for another item is refused", async () => {
    const params = { sellerAddress: ME, originalOrderHash: ORIGINAL, durationSeconds: 86_400, priceRaw: "2000000000000000000", salt: "0xdef", startTime: now() + 30 };
    const built = buildIntent("counter-offer", params, { nftContract: NFT, tokenId: "43", currency: STRK, ...inputs }, config);
    const res = await app().request("/counter-offer", post({ ...params, built }));
    expect(res.status).toBe(422);
    expect(created).toHaveLength(0);
  });
});

describe("a purchase the client built", () => {
  const BUYER = "0x0999999999999999999999999999999999999999999999999999999999999999";
  const purchase = { fulfiller: BUYER, orderHash: ORIGINAL };
  const listed = () => ({
    offer: { itemType: "ERC721", token: NFT, identifier: "42", startAmount: "1", endAmount: "1" },
    consideration: { itemType: "ERC20", token: STRK, identifier: "0", startAmount: "1500000000000000000", endAmount: "1500000000000000000", recipient: ME },
  });
  const feeOn = resolveConfig({ feeConfig: { enabled: true } });
  const feeOff = resolveConfig({ feeConfig: { enabled: false } });

  test("a Medialane app's purchase with the platform fee is recorded", async () => {
    stored = myListing;
    const built = buildIntent("fulfill", purchase, { order: listed(), is1155: false }, feeOn);
    expect(built.calls.map((c) => c.entrypoint)).toEqual(["approve", "fulfill_order", "transfer"]);
    const res = await app("MEDIALANE_IO").request("/fulfill", post({ ...purchase, built }));
    expect(res.status).toBe(201);
  });

  test("a Medialane app's purchase without the fee is refused", async () => {
    stored = myListing;
    const built = buildIntent("fulfill", purchase, { order: listed(), is1155: false }, feeOff);
    const res = await app("MEDIALANE_IO").request("/fulfill", post({ ...purchase, built }));
    expect(res.status).toBe(422);
    expect(created).toHaveLength(0);
  });

  test("an API app's purchase carries no fee", async () => {
    stored = myListing;
    const built = buildIntent("fulfill", purchase, { order: listed(), is1155: false }, feeOff);
    const res = await app().request("/fulfill", post({ ...purchase, built }));
    expect(res.status).toBe(201);
  });

  test("a checkout item built by the client is checked", async () => {
    stored = myListing;
    const good = buildIntent("fulfill", purchase, { order: listed(), is1155: false }, feeOn);
    expect((await app("MEDIALANE_IO").request("/checkout", post({ fulfiller: BUYER, items: [{ orderHash: ORIGINAL, built: good }] }))).status).toBe(201);
    created = [];
    const bad = buildIntent("fulfill", purchase, { order: listed(), is1155: false }, feeOff);
    const res = await app("MEDIALANE_IO").request("/checkout", post({ fulfiller: BUYER, items: [{ orderHash: ORIGINAL, built: bad }] }));
    expect(res.status).toBe(422);
    expect(created).toHaveLength(0);
  });
});

describe("a transfer the client built", () => {
  const TO = "0x0999999999999999999999999999999999999999999999999999999999999999";
  const config = resolveConfig({ feeConfig: { fundAddress: FUND } });

  test("an NFT transfer built by the client is recorded when it matches", async () => {
    const params = { owner: ME, contractAddress: NFT, tokenId: "42", recipient: TO, tokenStandard: "ERC721" as const };
    const built = buildIntent("transfer-nft", params, {}, config);
    expect((await app().request("/transfer-nft", post({ ...params, built }))).status).toBe(201);
  });

  test("an NFT transfer built for another recipient is refused", async () => {
    const params = { owner: ME, contractAddress: NFT, tokenId: "42", recipient: TO, tokenStandard: "ERC721" as const };
    const built = buildIntent("transfer-nft", { ...params, recipient: ME }, {}, config);
    expect((await app().request("/transfer-nft", post({ ...params, built }))).status).toBe(422);
    expect(created).toHaveLength(0);
  });

  test("a funding transfer built to the platform fund is recorded", async () => {
    const params = { owner: ME, asset: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", amountAtomic: "2500000" };
    const built = buildIntent("funding-transfer", params, {}, config);
    expect((await app().request("/funding-transfer", post({ ...params, built }))).status).toBe(201);
  });

  test("a funding transfer built to another address is refused", async () => {
    const params = { owner: ME, asset: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", amountAtomic: "2500000" };
    const built = buildIntent("funding-transfer", params, {}, resolveConfig({ feeConfig: { fundAddress: TO } }));
    expect((await app().request("/funding-transfer", post({ ...params, built }))).status).toBe(422);
  });

  test("a token the platform doesn't support is still refused with its reason", async () => {
    const res = await app().request("/transfer-token", post({ owner: ME, token: "0x999", recipient: TO, amount: "1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That token is not supported" });
  });
});
