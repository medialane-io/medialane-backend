import { Account, type AccountInterface } from "starknet";
import { getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import { createProvider } from "../utils/starknet.js";

const MEDIAWALLET_CLASS_HASH = getCoordinates("STARKNET").mediaWalletClassHash!;

export function isRelayerConfigured(): boolean {
  return Boolean(process.env.WALLET_RELAYER_PRIVATE_KEY && process.env.WALLET_RELAYER_ADDRESS);
}

function relayerAccount(): AccountInterface {
  const privateKey = process.env.WALLET_RELAYER_PRIVATE_KEY;
  const address = process.env.WALLET_RELAYER_ADDRESS;
  if (!privateKey || !address) throw new Error("WALLET_RELAYER_PRIVATE_KEY is not set");
  return new Account({ provider: createProvider(), address, signer: privateKey, cairoVersion: "1" });
}

/**
 * Deploys a MediaWallet on behalf of `ownerPubkey`, paid for by Medialane's
 * relayer account, via Starknet's Universal Deployer Contract
 * (`Account.deployContract` — no custom factory contract; see the design
 * spec §3.3, verified live on mainnet 2026-08-06). The resulting wallet is
 * owned solely by `ownerPubkey` from the first block — the relayer never
 * becomes an owner, never holds any authority over the deployed wallet.
 */
export async function deployWalletViaRelayer(
  ownerPubkey: string,
  salt: string = "0x0",
  // `relayerAccount()` in this default only evaluates when `deps` is
  // omitted — it throws "WALLET_RELAYER_PRIVATE_KEY is not set" itself if
  // unconfigured, so no separate guard is needed in the body below (an
  // explicit `deps.account` from a caller, e.g. a test's fake, always skips
  // this entirely per normal JS default-parameter evaluation).
  deps: { account: AccountInterface } = { account: relayerAccount() },
): Promise<{ address: string; transactionHash: string }> {
  const result = await deps.account.deployContract({
    classHash: MEDIAWALLET_CLASS_HASH,
    constructorCalldata: ownerConstructorCalldata(ownerPubkey),
    salt,
  });
  // deployContract() resolves as soon as the transaction is submitted, not
  // once it's confirmed. The caller (POST /v1/wallet/deploy) immediately
  // hands off to SIWS sign-in, which independently checks on-chain that the
  // wallet exists — without this wait, that check can run before the
  // deployment has actually landed, failing with a confusing
  // "account_not_deployed" error moments after setup appeared to succeed.
  await deps.account.provider.waitForTransaction(result.transaction_hash);
  return { address: result.contract_address as string, transactionHash: result.transaction_hash };
}
