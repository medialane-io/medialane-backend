import { test, expect } from "bun:test";
import { buildActivityWhere } from "./activities.js";
import { chainWhere } from "../utils/chainFilter.js";

const CHAIN = { chain: "STARKNET" as const };
const CONTRACT = "0x0000000000000000000000000000000000000000000000000000000000000abc";

test("no contract param — filters stay chain-only (existing global-feed behavior)", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({ chainFilter: CHAIN });
  expect(transferWhere).toEqual({ ...chainWhere(CHAIN) });
  expect(orderWhere).toEqual({ ...chainWhere(CHAIN) });
});

test("contract param — scopes both tables to that contract, skips hiddenContractFilter", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({
    chainFilter: CHAIN,
    contract: CONTRACT,
    hiddenContractFilter: { notIn: [CONTRACT] }, // even if hidden, an explicit collection page still shows its own feed
  });
  expect(transferWhere.contractAddress).toBe(CONTRACT);
  expect(orderWhere.nftContract).toBe(CONTRACT);
});

test("mint/transfer type still narrows fromAddress alongside a contract filter", () => {
  const { transferWhere } = buildActivityWhere({ chainFilter: CHAIN, type: "mint", contract: CONTRACT });
  expect(transferWhere.contractAddress).toBe(CONTRACT);
  expect(transferWhere.fromAddress).toBe("0x0000000000000000000000000000000000000000000000000000000000000000");
});

test("no contract param — hiddenContractFilter still applies (unchanged global-feed safety)", () => {
  const { transferWhere, orderWhere } = buildActivityWhere({
    chainFilter: CHAIN,
    hiddenContractFilter: { notIn: [CONTRACT] },
  });
  expect(transferWhere.contractAddress).toEqual({ notIn: [CONTRACT] });
  expect(orderWhere.nftContract).toEqual({ notIn: [CONTRACT] });
});
