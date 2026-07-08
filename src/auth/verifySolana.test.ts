import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { verifyWalletSignature } from "./verify.js";

describe("Solana ed25519 verify", () => {
  test("locally generated signature verifies; tampered fails", async () => {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    const address = base58.encode(pub);
    const message = "medialane sign-in nonce:xyz chain:SOLANA";
    const sig = base58.encode(ed25519.sign(new TextEncoder().encode(message), priv));
    expect(
      await verifyWalletSignature({ chain: "SOLANA", address, typedData: null, signature: [sig], message }),
    ).toEqual({ ok: true });
    expect(
      await verifyWalletSignature({ chain: "SOLANA", address, typedData: null, signature: [sig], message: message + "!" }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
