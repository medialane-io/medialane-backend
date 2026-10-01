import { describe, expect, test } from "bun:test";
import type { Call } from "starknet";
import { computeOwnerGuid } from "@medialane/sdk/starknet";
import { provisioningKeyWith } from "../utils/provisioningKey.js";
import { needsKeySetup, setupWalletKey, type WalletKeyDeps } from "./walletKey.js";

const SECRET = "d".repeat(64);
const WALLET = "0xabc";
const PASSKEY = "0x0123";
const backendKey = provisioningKeyWith(SECRET, "acc-1");
const proof = { signature: ["0x1", "0x2"], expiration: 2_000_000_000 };

function fakeDeps(overrides: Partial<WalletKeyDeps> = {}) {
  let owners = [computeOwnerGuid(backendKey.publicKey)];
  const executed: { walletAddress: string; calls: Call[]; privateKey: string }[] = [];
  const deps: WalletKeyDeps = {
    emailVerified: async () => true,
    walletOf: async () => WALLET,
    ownerGuidsOf: async () => owners,
    keyFor: (accountId) => provisioningKeyWith(SECRET, accountId),
    execute: async (input) => {
      executed.push(input);
      owners = [computeOwnerGuid(PASSKEY)];
      return "0xtx";
    },
    waitFor: async () => {},
    ...overrides,
  };
  return { deps, executed, setOwners: (next: string[]) => (owners = next) };
}

describe("setupWalletKey", () => {
  test("replaces the backend key with the passkey in one change_owners", async () => {
    const { deps, executed } = fakeDeps();
    expect(await setupWalletKey(deps, "acc-1", PASSKEY, proof)).toEqual({ status: 200, walletAddress: WALLET });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.walletAddress).toBe(WALLET);
    expect(executed[0]!.privateKey).toBe(backendKey.privateKey);
    expect(executed[0]!.calls.map((c) => c.entrypoint)).toEqual(["change_owners"]);
  });

  test("does nothing when the passkey already owns the wallet, so a retry or second device is safe", async () => {
    const { deps, executed, setOwners } = fakeDeps();
    setOwners([computeOwnerGuid(PASSKEY)]);
    expect(await setupWalletKey(deps, "acc-1", PASSKEY, proof)).toEqual({ status: 200, walletAddress: WALLET });
    expect(executed).toHaveLength(0);
  });

  test("refuses a wallet the backend key does not own", async () => {
    const { deps, executed, setOwners } = fakeDeps();
    setOwners([computeOwnerGuid("0x0999")]);
    expect((await setupWalletKey(deps, "acc-1", PASSKEY, proof)).status).toBe(409);
    expect(executed).toHaveLength(0);
  });

  test("uses only the key computed for this account", async () => {
    const { deps, executed } = fakeDeps();
    expect((await setupWalletKey(deps, "acc-2", PASSKEY, proof)).status).toBe(409);
    expect(executed).toHaveLength(0);
  });

  test("refuses an account whose email was never proven", async () => {
    const { deps, executed } = fakeDeps({ emailVerified: async () => false });
    expect((await setupWalletKey(deps, "acc-1", PASSKEY, proof)).status).toBe(403);
    expect(executed).toHaveLength(0);
  });

  test("answers 404 for an account with no wallet", async () => {
    const { deps } = fakeDeps({ walletOf: async () => null });
    expect((await setupWalletKey(deps, "acc-1", PASSKEY, proof)).status).toBe(404);
  });

  test("reports failure when the passkey is not the only owner afterwards", async () => {
    const { deps } = fakeDeps({ execute: async () => "0xtx" });
    expect((await setupWalletKey(deps, "acc-1", PASSKEY, proof)).status).toBe(502);
  });

  test("reports failure when the transaction fails", async () => {
    const { deps } = fakeDeps({
      execute: async () => {
        throw new Error("paymaster down");
      },
    });
    expect(await setupWalletKey(deps, "acc-1", PASSKEY, proof)).toEqual({ status: 502, error: "paymaster down" });
  });
});

describe("needsKeySetup", () => {
  test("is true while the backend key owns the wallet", async () => {
    const { deps } = fakeDeps();
    expect(await needsKeySetup(deps, "acc-1", WALLET)).toBe(true);
  });

  test("is false once the passkey owns it", async () => {
    const { deps, setOwners } = fakeDeps();
    setOwners([computeOwnerGuid(PASSKEY)]);
    expect(await needsKeySetup(deps, "acc-1", WALLET)).toBe(false);
  });

  test("is false for a wallet owned by another key", async () => {
    const { deps, setOwners } = fakeDeps();
    setOwners([computeOwnerGuid("0x0999")]);
    expect(await needsKeySetup(deps, "acc-1", WALLET)).toBe(false);
  });

  test("is false when no secret is configured", async () => {
    const { deps } = fakeDeps({
      keyFor: () => {
        throw new Error("PROVISIONING_SECRET is not configured");
      },
    });
    expect(await needsKeySetup(deps, "acc-1", WALLET)).toBe(false);
  });
});
