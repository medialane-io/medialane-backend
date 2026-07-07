import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";

// The EVM verify path defers to viem's verification; this exercises the
// EOA signature shape we pass through (client-independent recover path).
describe("EVM EIP-191 signature shape", () => {
  test("locally generated viem signature verifies", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = "medialane sign-in nonce:abc chain:BASE";
    const signature = await account.signMessage({ message });
    expect(await verifyMessage({ address: account.address, message, signature })).toBe(true);
    expect(
      await verifyMessage({ address: account.address, message: message + "x", signature }),
    ).toBe(false);
  });
});
