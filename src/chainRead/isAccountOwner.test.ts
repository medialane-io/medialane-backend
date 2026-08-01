import { describe, expect, test, mock } from "bun:test";

describe("starknet is_owner calldata", () => {
  test("encodes Signer::Starknet(pubkey) as [tag=0, pubkey] and parses a truthy result", async () => {
    let capturedCall: { contractAddress: string; entrypoint: string; calldata: string[] } | undefined;
    const fakeProvider = {
      callContract: mock(async (call: any) => {
        capturedCall = call;
        return ["0x1"];
      }),
    };
    const { __unstable_starknetIsAccountOwnerWithProvider } = await import("./index.js");
    const result = await __unstable_starknetIsAccountOwnerWithProvider(
      fakeProvider as any,
      "0xaccount",
      "0xpubkey",
    );
    expect(capturedCall).toEqual({
      contractAddress: "0xaccount",
      entrypoint: "is_owner",
      calldata: ["0x0", "0xpubkey"],
    });
    expect(result).toBe(true);
  });

  test("parses a falsy on-chain result as false", async () => {
    const fakeProvider = { callContract: mock(async () => ["0x0"]) };
    const { __unstable_starknetIsAccountOwnerWithProvider } = await import("./index.js");
    const result = await __unstable_starknetIsAccountOwnerWithProvider(fakeProvider as any, "0xaccount", "0xpubkey");
    expect(result).toBe(false);
  });
});
