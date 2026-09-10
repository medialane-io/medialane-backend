import { test, expect } from "bun:test";
import { serviceForFactory } from "./factoryService.js";
import { getService } from "@medialane/sdk";

const IP_COLLECTION = getService("mip-erc721")!.onchain!.STARKNET!.factoryAddress!;
const DATA_TOKENIZATION = getService("data-tokenization-erc721")!.onchain!.STARKNET!.factoryAddress!;

test("the original factory still attributes to IP Collection", () => {
  expect(serviceForFactory(IP_COLLECTION)).toBe("mip-erc721");
});

test("the new factory attributes to Data Tokenization", () => {
  expect(serviceForFactory(DATA_TOKENIZATION)).toBe("data-tokenization-erc721");
});

test("the two factories are different addresses", () => {
  expect(IP_COLLECTION).not.toBe(DATA_TOKENIZATION);
});

test("an unpadded address matches the same service", () => {
  const unpadded = "0x" + DATA_TOKENIZATION.replace(/^0x0*/, "");
  expect(serviceForFactory(unpadded)).toBe("data-tokenization-erc721");
});

test("an unknown factory falls back rather than throwing", () => {
  expect(serviceForFactory("0x123")).toBe("mip-erc721");
});
