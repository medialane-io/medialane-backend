import { describe, expect, test } from "bun:test";
import { settledByAnotherWallet } from "./txVerifier.js";

const REQUESTER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SOMEONE_ELSE = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const RELAYER = "0x03a90664ef86880dbe6bf9c6c8f874177944a3e48b40463e8de60bcb3d4790f5";

describe("whose transaction may settle an intent", () => {
  test("the wallet the intent was built for may settle it", () => {
    expect(settledByAnotherWallet({ sender: REQUESTER, calldata: [] }, REQUESTER)).toBe(false);
  });

  test("the same wallet written unpadded is still that wallet", () => {
    const unpadded = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(settledByAnotherWallet({ sender: unpadded, calldata: [] }, REQUESTER)).toBe(false);
  });

  test("another wallet may not", () => {
    expect(settledByAnotherWallet({ sender: SOMEONE_ELSE, calldata: [] }, REQUESTER)).toBe(true);
  });

  test("a sender that could not be read is not held against the intent", () => {
    expect(settledByAnotherWallet({ sender: null, calldata: [] }, REQUESTER)).toBe(false);
  });

  test("a sponsored transaction names its owner in the call, not as the sender", () => {
    expect(settledByAnotherWallet({ sender: RELAYER, calldata: ["0x1", "0xdead", REQUESTER] }, REQUESTER)).toBe(false);
  });

  test("a sponsored transaction naming the owner unpadded still belongs to them", () => {
    const unpadded = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(settledByAnotherWallet({ sender: RELAYER, calldata: ["0x1", unpadded] }, REQUESTER)).toBe(false);
  });

  test("a relayed transaction that never names the requester may not settle their intent", () => {
    expect(settledByAnotherWallet({ sender: RELAYER, calldata: ["0x1", SOMEONE_ELSE] }, REQUESTER)).toBe(true);
  });

  test("calldata that cannot be read falls back to the sender", () => {
    expect(settledByAnotherWallet({ sender: SOMEONE_ELSE, calldata: null }, REQUESTER)).toBe(true);
  });

  test("a malformed calldata entry does not crash the comparison", () => {
    expect(settledByAnotherWallet({ sender: RELAYER, calldata: ["", "not-hex", REQUESTER] }, REQUESTER)).toBe(false);
  });
});

describe("the sponsored offer that was refused in production on 2026-09-22", () => {
  const owner = "0x071c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f";
  const paymasterRelayer = "0x3a90664ef86880dbe6bf9c6c8f874177944a3e48b40463e8de60bcb3d4790f5";
  const calldata = [
    "0x1",
    "0x127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f",
    "0x3d82f059acd7c22528fe93d2cd7c941d47411bf7c5525efe7f71eedebd62647",
    "0x29",
    "0x71c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f",
    "0x34cc13b274446654ca3233ed2c1620d4c5d1d32fd20b47146a3371064bdc57d",
  ];

  test("settles, because the relayer carried the owner's call", () => {
    expect(settledByAnotherWallet({ sender: paymasterRelayer, calldata }, owner)).toBe(false);
  });

  test("still refuses that same transaction for a wallet it never names", () => {
    const stranger = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
    expect(settledByAnotherWallet({ sender: paymasterRelayer, calldata }, stranger)).toBe(true);
  });
});
