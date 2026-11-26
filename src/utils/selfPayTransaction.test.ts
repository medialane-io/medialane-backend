import { describe, expect, test } from "bun:test";
import { RpcError, Signer, constants, ec, stark } from "starknet";
import { parseSelfPayDetails, selfPayTransactionHash, walletAccepts } from "./selfPayTransaction.js";

const WALLET = "0x00df8058ae5cdf8f2411013a17f18b5c1ec5619c45aed540d811ec8514b3823c";
const PRIVATE_KEY = "0x1234567890abcdef";
const CALLS = [
  { contractAddress: "0x1", entrypoint: "mint_edition", calldata: ["0x2", "10", "0"] },
  { contractAddress: "0x1", entrypoint: "set_token_royalty", calldata: ["1", "0", "0x2", "500"] },
];
const bounds = (l2: bigint) => ({
  l1_gas: { max_amount: 0n, max_price_per_unit: 100n },
  l2_gas: { max_amount: l2, max_price_per_unit: 200n },
  l1_data_gas: { max_amount: 300n, max_price_per_unit: 400n },
});
const wire = {
  nonce: "0x5",
  tip: "0x7",
  resourceBounds: {
    l1_gas: { max_amount: "0x0", max_price_per_unit: "0x64" },
    l2_gas: { max_amount: "0x3e8", max_price_per_unit: "0xc8" },
    l1_data_gas: { max_amount: "0x12c", max_price_per_unit: "0x190" },
  },
};

async function walletSignature(l2: bigint) {
  const signature = await new Signer(PRIVATE_KEY).signTransaction(CALLS, {
    walletAddress: WALLET,
    chainId: constants.StarknetChainId.SN_MAIN,
    cairoVersion: "1",
    version: "0x3",
    nonce: 5n,
    tip: 7n,
    resourceBounds: bounds(l2),
    paymasterData: [],
    accountDeploymentData: [],
    nonceDataAvailabilityMode: "L1",
    feeDataAvailabilityMode: "L1",
  } as never);
  return stark.formatSignature(signature);
}

function signs(signature: string[], messageHash: string): boolean {
  const key = ec.starkCurve.getStarkKey(PRIVATE_KEY).slice(2).padStart(64, "0");
  const parsed = new ec.starkCurve.Signature(BigInt(signature[0]!), BigInt(signature[1]!));
  return ["02", "03"].some((prefix) => ec.starkCurve.verify(parsed, messageHash, prefix + key));
}

describe("selfPayTransactionHash", () => {
  test("is the hash a wallet signs when it submits the same calls and fee limits", async () => {
    const messageHash = selfPayTransactionHash(WALLET, CALLS, parseSelfPayDetails(wire)!);
    expect(signs(await walletSignature(1000n), messageHash)).toBe(true);
  });

  test("differs when the wallet signs other fee limits", async () => {
    const messageHash = selfPayTransactionHash(WALLET, CALLS, parseSelfPayDetails(wire)!);
    expect(signs(await walletSignature(1001n), messageHash)).toBe(false);
  });
});

describe("parseSelfPayDetails", () => {
  test("refuses missing, non-numeric and negative fields", () => {
    expect(parseSelfPayDetails({})).toBeNull();
    expect(parseSelfPayDetails({ ...wire, nonce: "abc" })).toBeNull();
    expect(parseSelfPayDetails({ ...wire, tip: "-1" })).toBeNull();
    expect(parseSelfPayDetails({ ...wire, tip: "" })).toBeNull();
    expect(parseSelfPayDetails({ ...wire, resourceBounds: { ...wire.resourceBounds, l2_gas: undefined } })).toBeNull();
  });
});

describe("walletAccepts", () => {
  const rpcError = (code: number, message: string) => new RpcError({ code, message } as never, "starknet_call", {});
  const ask = (answer: () => Promise<string[]>) => walletAccepts(answer, WALLET, "0xabc", ["1", "0x2"]);

  test("asks the wallet contract about that exact hash and signature", async () => {
    const asked: unknown[] = [];
    const proof = await walletAccepts(async (call) => { asked.push(call); return ["0x56414c4944"]; }, WALLET, "0xabc", ["1", "0x2"]);
    expect(proof).toEqual({ ok: true });
    expect(asked).toEqual([{ contractAddress: WALLET, entrypoint: "is_valid_signature", calldata: ["0xabc", "0x2", "1", "0x2"] }]);
  });

  test("any other answer, or a revert, is a refusal", async () => {
    expect(await ask(async () => ["0x0"])).toEqual({ ok: false, reason: "invalid" });
    expect(await ask(async () => { throw rpcError(40, "Contract error"); })).toEqual({ ok: false, reason: "invalid" });
  });

  test("a wallet that is not on chain is reported as not deployed", async () => {
    expect(await ask(async () => { throw rpcError(20, "Contract not found"); })).toEqual({ ok: false, reason: "not_deployed" });
  });

  test("a node that cannot answer is not a refusal", async () => {
    await expect(ask(async () => { throw new Error("fetch failed"); })).rejects.toThrow("fetch failed");
    await expect(ask(async () => { throw rpcError(63, "An unexpected error occurred"); })).rejects.toBeInstanceOf(RpcError);
  });
});
