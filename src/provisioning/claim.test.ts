import { describe, expect, test } from "bun:test";
import type { Call } from "starknet";
import { provisioningKeyWith } from "../utils/provisioningKey.js";
import { claimWallets, type ClaimDeps, type WaitingRow } from "./claim.js";

const SECRET = "d".repeat(64);
const NEW_OWNER = "0x0123";
const keyInput = { apiClientId: "biz-1", recipientScheme: "email", recipientValue: "ana@example.com", salt: "0123456789abcdef" };
const key = provisioningKeyWith(SECRET, keyInput);

const row = (overrides: Partial<WaitingRow> = {}): WaitingRow => ({
  id: "prov-1",
  apiClientId: "biz-1",
  chain: "STARKNET",
  walletAddress: "0xabc",
  recipientScheme: "email",
  recipientValue: "ana@example.com",
  interimOwnerPubkey: key.publicKey,
  derivationSalt: "0123456789abcdef",
  ...overrides,
});

function fakeDeps(overrides: Partial<ClaimDeps> = {}) {
  const executed: { userAddress: string; calls: Call[]; signature: string[] }[] = [];
  const linked: string[] = [];
  const transferred: string[] = [];
  const deps: ClaimDeps = {
    verifiedEmailOf: async () => "ana@example.com",
    waitingFor: async () => [row()],
    keyFor: (input) => provisioningKeyWith(SECRET, input),
    buildInvoke: async (userAddress, calls) => ({ userAddress, calls }),
    executeInvoke: async (userAddress, _typedData, signature, calls) => {
      executed.push({ userAddress, calls, signature });
      return "0xtx";
    },
    signTypedData: () => ["0xr", "0xs"],
    linkWallet: async ({ walletAddress }) => {
      linked.push(walletAddress);
    },
    markTransferred: async (id) => {
      transferred.push(id);
    },
    ...overrides,
  };
  return { deps, executed, linked, transferred };
}

const proof = (walletAddress = "0xabc") => ({ walletAddress, signature: ["0x1", "0x2"], expiration: 2_000_000_000 });

describe("claimWallets", () => {
  test("hands the wallet to the user's key and removes the temporary key in one transaction", async () => {
    const { deps, executed, linked, transferred } = fakeDeps();
    const outcome = await claimWallets(deps, "acc-1", NEW_OWNER, [proof()]);
    expect(outcome).toEqual({ status: 200, claimed: ["0xabc"] });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.userAddress).toBe("0xabc");
    expect(executed[0]!.calls).toHaveLength(1);
    expect(executed[0]!.calls[0]!.entrypoint).toBe("change_owners");
    expect(linked).toEqual(["0xabc"]);
    expect(transferred).toEqual(["prov-1"]);
  });

  test("refuses an account whose email was never proven", async () => {
    const { deps, executed } = fakeDeps({ verifiedEmailOf: async () => null });
    expect(await claimWallets(deps, "acc-1", NEW_OWNER, [proof()])).toEqual({ status: 403, error: "Verify your email first" });
    expect(executed).toHaveLength(0);
  });

  test("hands over nothing for an address not waiting for this email", async () => {
    const { deps, executed } = fakeDeps();
    const outcome = await claimWallets(deps, "acc-1", NEW_OWNER, [proof("0xdef")]);
    expect(outcome.status).toBe(404);
    expect(executed).toHaveLength(0);
  });

  test("skips a wallet whose key the backend cannot compute and still claims the others", async () => {
    const { deps, executed } = fakeDeps({
      waitingFor: async () => [row({ id: "old", walletAddress: "0x111", interimOwnerPubkey: "0x999" }), row()],
    });
    const outcome = await claimWallets(deps, "acc-1", NEW_OWNER, [proof("0x111"), proof("0xabc")]);
    expect(outcome).toEqual({ status: 200, claimed: ["0xabc"] });
    expect(executed.map((e) => e.userAddress)).toEqual(["0xabc"]);
  });

  test("marks nothing transferred when the transaction fails", async () => {
    const { deps, transferred, linked } = fakeDeps({
      executeInvoke: async () => {
        throw new Error("paymaster down");
      },
    });
    const outcome = await claimWallets(deps, "acc-1", NEW_OWNER, [proof()]);
    expect(outcome.status).toBe(502);
    expect(transferred).toEqual([]);
    expect(linked).toEqual([]);
  });

  test("finds the waiting wallets for an account email stored with capitals", async () => {
    const asked: string[] = [];
    const { deps } = fakeDeps({
      verifiedEmailOf: async () => "Ana@Example.com",
      waitingFor: async (email) => {
        asked.push(email);
        return [row()];
      },
    });
    await claimWallets(deps, "acc-1", NEW_OWNER, [proof()]);
    expect(asked).toEqual(["ana@example.com"]);
  });

  test("matches addresses written with or without leading zeros", async () => {
    const { deps } = fakeDeps({ waitingFor: async () => [row({ walletAddress: "0x0abc" })] });
    const outcome = await claimWallets(deps, "acc-1", NEW_OWNER, [proof("0xabc")]);
    expect(outcome).toEqual({ status: 200, claimed: ["0x0abc"] });
  });
});
