import { expect, test } from "bun:test";
import { royaltyInfoCalldata } from "./shared.js";

test("royalty_info calldata is hex felts: token id low and high, sale price 10000, high 0", () => {
  expect(royaltyInfoCalldata("1")).toEqual(["0x1", "0x0", "0x2710", "0x0"]);
});

test("a token id above 2^128 splits into low and high", () => {
  expect(royaltyInfoCalldata((2n ** 128n + 5n).toString())).toEqual(["0x5", "0x1", "0x2710", "0x0"]);
});
