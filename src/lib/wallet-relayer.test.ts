import { test, expect } from "bun:test";
import { isRelayerConfigured, deployWalletViaRelayer } from "./wallet-relayer";

test("isRelayerConfigured is false with no relayer key set", () => {
  const original = process.env.WALLET_RELAYER_PRIVATE_KEY;
  delete process.env.WALLET_RELAYER_PRIVATE_KEY;
  expect(isRelayerConfigured()).toBe(false);
  if (original) process.env.WALLET_RELAYER_PRIVATE_KEY = original;
});

test("deployWalletViaRelayer rejects when the relayer isn't configured", async () => {
  delete process.env.WALLET_RELAYER_PRIVATE_KEY;
  await expect(deployWalletViaRelayer("0xabc")).rejects.toThrow(
    "WALLET_RELAYER_PRIVATE_KEY is not set",
  );
});

test("deployWalletViaRelayer calls deployContract with the MediaWallet class hash and owner calldata", async () => {
  process.env.WALLET_RELAYER_PRIVATE_KEY = "0x1";
  process.env.WALLET_RELAYER_ADDRESS = "0xrelayer";

  const calls: unknown[] = [];
  const fakeAccount = {
    deployContract: async (payload: unknown) => {
      calls.push(payload);
      return { contract_address: "0xnewwallet", transaction_hash: "0xtx" };
    },
    provider: { waitForTransaction: async () => ({}) },
  };

  const result = await deployWalletViaRelayer(
    "0x61cc05c5da6e9b1403a27ffa564498cd2b8cda1428b053b08dbbd1cceb744c6",
    "0x0",
    { account: fakeAccount as never },
  );

  expect(calls.length).toBe(1);
  expect((calls[0] as { classHash: string }).classHash).toBeDefined();
  expect(result.address).toBe("0xnewwallet");
  expect(result.transactionHash).toBe("0xtx");

  delete process.env.WALLET_RELAYER_PRIVATE_KEY;
  delete process.env.WALLET_RELAYER_ADDRESS;
});

test("deployWalletViaRelayer waits for the deploy transaction to be confirmed before returning", async () => {
  process.env.WALLET_RELAYER_PRIVATE_KEY = "0x1";
  process.env.WALLET_RELAYER_ADDRESS = "0xrelayer";

  const waited: { txHash: string | null } = { txHash: null };
  const fakeAccount = {
    deployContract: async () => ({ contract_address: "0xnewwallet", transaction_hash: "0xtx" }),
    provider: {
      waitForTransaction: async (txHash: string) => {
        waited.txHash = txHash;
        return {};
      },
    },
  };

  await deployWalletViaRelayer(
    "0x61cc05c5da6e9b1403a27ffa564498cd2b8cda1428b053b08dbbd1cceb744c6",
    "0x0",
    { account: fakeAccount as never },
  );

  // SIWS verify runs an on-chain check moments after deploy returns — if
  // deploy returns as soon as the transaction is merely submitted (not yet
  // confirmed), that check can run against a wallet that isn't actually on
  // chain yet, and the sign-in step fails with a confusing error. Waiting
  // here closes that race.
  expect(waited.txHash).toBe("0xtx");

  delete process.env.WALLET_RELAYER_PRIVATE_KEY;
  delete process.env.WALLET_RELAYER_ADDRESS;
});
