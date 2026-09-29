import { z } from "zod";
import { x402Config } from "../../config/x402.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import type { verifyWalletSignature } from "../../auth/verify.js";
import { FINALIZED_STATUSES, type StarknetReceipt } from "../../payments/schemes/starknet.js";
import { depositNonce, parseDepositEvents, type DepositEvent } from "../deposits.js";
import type { FundingIntentRecord, FundingMethod, VerifiedPayment } from "../types.js";

export const MIN_AMOUNT_ATOMIC = 1_000_000n; // 1 USDC = 100 credits
export const MAX_AMOUNT_ATOMIC = 10_000_000_000n; // 10,000 USDC

export function atomicFromUsdc(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** 6n + BigInt(fraction.padEnd(6, "0"));
}

const paramsSchema = z.object({
  chain: z.literal("STARKNET").default("STARKNET"),
  amountUsdc: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/),
});
const challengeSchema = z.object({ payer: z.string().min(3) });
const authorizeSchema = z.object({ payer: z.string().min(3), signature: z.array(z.string()).min(1) });
const submitSchema = z.object({ txHash: z.string().min(3) });

export function fundingTypedData(input: { intentId: string; payer: string; amountAtomic: bigint }) {
  return {
    domain: { name: "Medialane", version: "1", chainId: "SN_MAIN", revision: "1" },
    primaryType: "FundingIntent",
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      FundingIntent: [
        { name: "intent", type: "shortstring" },
        { name: "wallet", type: "ContractAddress" },
        { name: "amount", type: "u128" },
        { name: "app", type: "shortstring" },
      ],
    },
    message: {
      intent: input.intentId,
      wallet: input.payer,
      amount: input.amountAtomic.toString(),
      app: "medialane.io/funding",
    },
  };
}

const same = (a: string, b: string) => normalizeAddress("STARKNET", a) === normalizeAddress("STARKNET", b);

const expectedAtomic = (intent: FundingIntentRecord): bigint => BigInt(String(intent.params.amountAtomic ?? "0"));

export function depositSatisfies(deposit: DepositEvent, intent: FundingIntentRecord): boolean {
  if (!intent.payer) return false;
  if (!same(deposit.token, x402Config.usdcContract)) return false;
  if (!same(deposit.payer, intent.payer)) return false;
  return deposit.amountAtomic >= expectedAtomic(intent);
}

export interface ChainTransferDeps {
  fetchReceipt: (hash: string) => Promise<StarknetReceipt>;
  verifySignature: typeof verifyWalletSignature;
}

export function createChainTransferMethod(deps: ChainTransferDeps): FundingMethod {
  return {
    id: "chain-transfer",

    available: () => Boolean(x402Config.treasury),

    describe: () => ({
      chains: ["STARKNET"],
      asset: "USDC",
      minAmountUsdc: "1",
      maxAmountUsdc: "10000",
    }),

    parseParams(raw) {
      const parsed = paramsSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "Enter an amount in USDC, for example 10 or 10.5." };
      const amount = atomicFromUsdc(parsed.data.amountUsdc);
      if (amount < MIN_AMOUNT_ATOMIC) return { ok: false, error: "The minimum top-up is 1 USDC." };
      if (amount > MAX_AMOUNT_ATOMIC) return { ok: false, error: "The maximum top-up is 10,000 USDC." };
      return { ok: true, params: { chain: parsed.data.chain, amountAtomic: amount.toString() } };
    },

    challenge(intent, body) {
      const parsed = challengeSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: "Choose the wallet you will pay from." };
      let payer: string;
      try {
        payer = normalizeAddress("STARKNET", parsed.data.payer);
      } catch {
        return { ok: false, error: "That wallet address is not valid." };
      }
      return { ok: true, typedData: fundingTypedData({ intentId: intent.id, payer, amountAtomic: expectedAtomic(intent) }) };
    },

    async authorize(intent, body) {
      if (intent.payer) return { ok: false, error: "This top-up already has a wallet." };
      const parsed = authorizeSchema.safeParse(body);
      if (!parsed.success) return { ok: false, error: "A wallet and its signature are required." };
      let payer: string;
      try {
        payer = normalizeAddress("STARKNET", parsed.data.payer);
      } catch {
        return { ok: false, error: "That wallet address is not valid." };
      }

      const result = await deps.verifySignature({
        chain: "STARKNET",
        address: payer,
        typedData: fundingTypedData({ intentId: intent.id, payer, amountAtomic: expectedAtomic(intent) }),
        signature: parsed.data.signature,
      });
      if (!result.ok) {
        return {
          ok: false,
          error:
            result.reason === "not_deployed"
              ? "That wallet is not deployed on Starknet yet."
              : "The wallet's signature did not check out.",
        };
      }

      return {
        ok: true,
        payer,
        instructions: {
          chain: "STARKNET",
          payTo: normalizeAddress("STARKNET", x402Config.treasury),
          asset: normalizeAddress("STARKNET", x402Config.usdcContract),
          amountAtomic: expectedAtomic(intent).toString(),
        },
      };
    },

    async verify(intent, evidence) {
      if (!intent.payer) return { ok: false, reason: "this top-up has no wallet yet" };
      const parsed = submitSchema.safeParse(evidence);
      if (!parsed.success) return { ok: false, reason: "a transaction hash is required" };

      let hash: string;
      try {
        hash = normalizeHash(parsed.data.txHash);
      } catch {
        return { ok: false, reason: "invalid transaction hash" };
      }

      let receipt: StarknetReceipt;
      try {
        receipt = await deps.fetchReceipt(hash);
      } catch {
        return { ok: false, reason: "the transfer is not in a block yet, try again in a moment" };
      }
      if (receipt.execution_status && receipt.execution_status !== "SUCCEEDED") {
        return { ok: false, reason: "transaction reverted" };
      }
      if (receipt.finality_status && !FINALIZED_STATUSES.has(receipt.finality_status)) {
        return { ok: false, reason: "transaction not yet finalized" };
      }

      // Receipts list events without their transaction hash, so stamp it on before parsing.
      const events = (receipt.events ?? []).map((ev) => ({ ...ev, transaction_hash: hash, block_number: 0 }));
      const deposit = parseDepositEvents(events as never, x402Config.treasury).find((d) => depositSatisfies(d, intent));
      if (!deposit) return { ok: false, reason: "no matching USDC transfer from your wallet to Medialane was found" };

      const payment: VerifiedPayment = {
        valueUsdcAtomic: deposit.amountAtomic,
        asset: deposit.token,
        payer: deposit.payer,
        proofNonce: depositNonce(deposit.txHash, deposit.depositIndex),
        scheme: "starknet-transfer",
        network: "starknet",
        txHash: deposit.txHash,
      };
      return { ok: true, payment };
    },
  };
}
