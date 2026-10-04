import { z } from "zod";
import { x402Config } from "../../config/x402.js";
import { acceptedTokens } from "../../payments/token-value.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import type { verifyWalletSignature } from "../../auth/verify.js";
import { FINALIZED_STATUSES, type StarknetReceipt } from "../../payments/schemes/starknet.js";
import { depositNonce, parseDepositEvents, type DepositEvent } from "../deposits.js";
import type { FundingIntentRecord, FundingMethod, VerifiedPayment } from "../types.js";
import { tokenAmountFor, tokenBySymbol, usdValueOf, type PriceReader } from "./assets.js";

export function atomicFromUsdc(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** 6n + BigInt(fraction.padEnd(6, "0"));
}

const paramsSchema = z.object({
  chain: z.literal("STARKNET").default("STARKNET"),
  amountUsdc: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional(),
  asset: z.string().min(1).max(12).optional(),
});
const challengeSchema = z.object({ payer: z.string().min(3) });
const authorizeSchema = z.object({ payer: z.string().min(3), signature: z.array(z.string()).min(1) });
const submitSchema = z.object({ txHash: z.string().min(3) });

export function fundingTypedData(input: { intentId: string; payer: string }) {
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
        { name: "app", type: "shortstring" },
      ],
    },
    message: {
      intent: input.intentId,
      wallet: input.payer,
      app: "medialane.io/funding",
    },
  };
}

const same = (a: string, b: string) => normalizeAddress("STARKNET", a) === normalizeAddress("STARKNET", b);

const suggestedUsd = (intent: FundingIntentRecord): bigint | null => {
  const raw = intent.params.suggestedUsdAtomic;
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : null;
};

const assetOf = (intent: FundingIntentRecord) =>
  tokenBySymbol(String(intent.params.asset ?? "USDC")) ?? tokenBySymbol("USDC")!;

export type DepositMatch =
  | { ok: true; valueUsdcAtomic: bigint }
  | { ok: false; reason: "mismatch" | "unpriced" | "dust" };

export async function depositValueFor(
  deposit: DepositEvent,
  intent: FundingIntentRecord,
  readPrices: PriceReader,
): Promise<DepositMatch> {
  if (!intent.payer || !same(deposit.payer, intent.payer)) return { ok: false, reason: "mismatch" };
  const token = acceptedTokens().find((t) => same(t.address, deposit.token));
  if (!token) return { ok: false, reason: "mismatch" };

  const value = await usdValueOf(token, deposit.amountAtomic, readPrices);
  if (value === null) return { ok: false, reason: "unpriced" };
  if (value < x402Config.usdcAtomicPerCredit) return { ok: false, reason: "dust" };
  return { ok: true, valueUsdcAtomic: value };
}

export interface ChainTransferDeps {
  fetchReceipt: (hash: string) => Promise<StarknetReceipt>;
  verifySignature: typeof verifyWalletSignature;
  readUsdPrices: PriceReader;
}

export function createChainTransferMethod(deps: ChainTransferDeps): FundingMethod {
  return {
    id: "chain-transfer",

    available: () => Boolean(x402Config.treasury),

    describe: () => ({
      chains: ["STARKNET"],
      assets: acceptedTokens().map((t) => ({ symbol: t.symbol, decimals: t.decimals })),
    }),

    parseParams(raw) {
      const parsed = paramsSchema.safeParse(raw ?? {});
      if (!parsed.success) return { ok: false, error: "Enter an amount in dollars, for example 10 or 10.5." };

      const params: Record<string, unknown> = { chain: parsed.data.chain };
      const token = tokenBySymbol(parsed.data.asset ?? "USDC");
      if (!token) return { ok: false, error: "That token can't be used to add credits." };
      params.asset = token.symbol;

      if (parsed.data.amountUsdc !== undefined) {
        const usd = atomicFromUsdc(parsed.data.amountUsdc);
        if (usd <= 0n) return { ok: false, error: "Enter an amount above zero." };
        params.suggestedUsdAtomic = usd.toString();
      }
      return { ok: true, params };
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
      return { ok: true, typedData: fundingTypedData({ intentId: intent.id, payer }) };
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
        typedData: fundingTypedData({ intentId: intent.id, payer }),
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

      const token = assetOf(intent);
      const instructions: Record<string, unknown> = {
        chain: "STARKNET",
        payTo: normalizeAddress("STARKNET", x402Config.treasury),
        asset: normalizeAddress("STARKNET", token.address),
        assetSymbol: token.symbol,
        assets: acceptedTokens().map((t) => ({
          symbol: t.symbol,
          address: normalizeAddress("STARKNET", t.address),
          decimals: t.decimals,
        })),
      };

      const usd = suggestedUsd(intent);
      if (usd !== null) {
        const amount = await tokenAmountFor(token, usd, deps.readUsdPrices);
        if (amount === null) return { ok: false, error: "Prices are unavailable right now. Try again shortly." };
        instructions.amountAtomic = amount.toString();
      }

      return { ok: true, payer, instructions };
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

      const events = (receipt.events ?? []).map((ev) => ({ ...ev, transaction_hash: hash, block_number: 0 }));
      let unpriced = false;
      let dust = false;
      for (const deposit of parseDepositEvents(events as never, x402Config.treasury)) {
        const match = await depositValueFor(deposit, intent, deps.readUsdPrices);
        if (match.ok) {
          const payment: VerifiedPayment = {
            valueUsdcAtomic: match.valueUsdcAtomic,
            asset: deposit.token,
            payer: deposit.payer,
            proofNonce: depositNonce(deposit.txHash, deposit.depositIndex),
            scheme: "starknet-transfer",
            network: "starknet",
            txHash: deposit.txHash,
          };
          return { ok: true, payment };
        }
        if (match.reason === "unpriced") unpriced = true;
        if (match.reason === "dust") dust = true;
      }
      if (unpriced) return { ok: false, reason: "could not price that token right now, try again shortly" };
      if (dust) return { ok: false, reason: "that transfer is worth less than one credit" };
      return { ok: false, reason: "no transfer from your wallet to Medialane was found" };
    },
  };
}
