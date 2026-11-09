import { describe, expect, test } from "bun:test";
import { getTokenBySymbol } from "@medialane/sdk";
import { buildAddOwnerCall, buildCancelEscapeCall, buildTriggerEscapeOwnerCall } from "@medialane/sdk/starknet";
import { buildWalletManageIntent, buildFundingTransferIntent, buildSwapIntent } from "./walletOps.js";
import { x402Config } from "../../config/x402.js";
import swapFixtures from "./swap.fixtures.test.json";

const ME = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const felts = (xs: readonly unknown[]) => xs.map((x) => BigInt(x as string));

describe("wallet operation intents", () => {
  test("add owner targets the owner's own wallet", async () => {
    const { calls } = await buildWalletManageIntent({ owner: ME, action: "add_owner", pubkey: "0x5" });
    const expected = buildAddOwnerCall(ME, "0x5");
    expect(BigInt(calls[0]!.contractAddress)).toBe(BigInt(expected.contractAddress));
    expect(calls[0]!.entrypoint).toBe(expected.entrypoint);
    expect(felts(calls[0]!.calldata)).toEqual(felts(expected.calldata as unknown[]));
  });

  test("cancel escape needs no extra input", async () => {
    const { calls } = await buildWalletManageIntent({ owner: ME, action: "cancel_escape" });
    expect(calls[0]!.entrypoint).toBe(buildCancelEscapeCall(ME).entrypoint);
  });

  test("trigger escape runs on the wallet being recovered", async () => {
    const { calls } = await buildWalletManageIntent({ owner: ME, action: "trigger_escape", newOwnerPubkey: "0x7" });
    expect(calls[0]!.entrypoint).toBe(buildTriggerEscapeOwnerCall(ME, "0x7").entrypoint);
    expect(BigInt(calls[0]!.contractAddress)).toBe(BigInt(ME));
  });

  test("add owner without a pubkey is refused", async () => {
    await expect(buildWalletManageIntent({ owner: ME, action: "add_owner" })).rejects.toThrow();
  });

  test("funding transfer pays the treasury in an accepted token", async () => {
    const usdc = getTokenBySymbol("USDC")!.address;
    const { calls } = await buildFundingTransferIntent({ owner: ME, asset: usdc, amountAtomic: "2500000" });
    expect(calls[0]!.entrypoint).toBe("transfer");
    const calldata = calls[0]!.calldata as string[];
    expect(calldata.slice(1)).toEqual(["2500000", "0"]);
    expect(BigInt(calldata[0]!)).toBe(BigInt(x402Config.treasury!));
  });

  test("funding transfer refuses a token that isn't accepted", async () => {
    await expect(buildFundingTransferIntent({ owner: ME, asset: "0x999", amountAtomic: "1" })).rejects.toThrow();
  });

  test("swap stores the calls of the best AVNU quote when they are within bounds", async () => {
    const route = swapFixtures.sell.calls;
    const deps = {
      getQuotes: async () => [{ quoteId: "q" }] as never,
      quoteToCalls: async () => ({ calls: route, chainId: "SN_MAIN" }) as never,
    };
    const { calls } = await buildSwapIntent(
      { taker: swapFixtures.taker, sellTokenAddress: swapFixtures.sellToken, buyTokenAddress: swapFixtures.buyToken, ...swapFixtures.sell.request },
      deps,
    );
    expect(calls).toEqual(route);
  });

  test("a route out of bounds is refused", async () => {
    const route = swapFixtures.sell.calls.map((call, i) =>
      i === 1 ? { ...call, calldata: call.calldata.map((v, j) => (j === 8 ? "0x0999" : v)) } : call,
    );
    const deps = {
      getQuotes: async () => [{ quoteId: "q" }] as never,
      quoteToCalls: async () => ({ calls: route, chainId: "SN_MAIN" }) as never,
    };
    await expect(
      buildSwapIntent(
        { taker: swapFixtures.taker, sellTokenAddress: swapFixtures.sellToken, buyTokenAddress: swapFixtures.buyToken, ...swapFixtures.sell.request },
        deps,
      ),
    ).rejects.toThrow("No swap route available for this pair");
  });

  test("swap with no route is refused", async () => {
    const deps = { getQuotes: async () => [] as never, quoteToCalls: async () => ({}) as never };
    const strk = getTokenBySymbol("STRK")!.address;
    const usdc = getTokenBySymbol("USDC")!.address;
    await expect(buildSwapIntent({ taker: ME, sellTokenAddress: strk, buyTokenAddress: usdc, sellAmountRaw: "10" }, deps)).rejects.toThrow();
  });
});
