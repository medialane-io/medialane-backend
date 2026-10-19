import { expect, mock, test } from "bun:test";

const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
const metadataUri = `data:application/json;utf8,${JSON.stringify({ image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` })}`;
let chainUri: string | null = metadataUri;

mock.module("../../orchestrator/metadata.js", () => ({
  fetchTokenUri: async () => chainUri,
}));

const { default: media } = await import("./media.js");

test("an on-chain image is served from the contract as a cacheable image", async () => {
  chainUri = metadataUri;
  const res = await media.request("/starknet/0x0abc/7/image");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/svg+xml");
  expect(res.headers.get("cache-control")).toContain("immutable");
  expect(await res.text()).toBe(svg);
});

test("a token whose metadata is a link has no on-chain image", async () => {
  chainUri = "ipfs://bafy/7.json";
  expect((await media.request("/starknet/0x0abc/7/image")).status).toBe(404);
});

test("malformed paths are refused", async () => {
  expect((await media.request("/ethereum/0x0abc/7/image")).status).toBe(404);
  expect((await media.request("/starknet/not-hex/7/image")).status).toBe(404);
  expect((await media.request("/starknet/0x0abc/x7/image")).status).toBe(404);
});
