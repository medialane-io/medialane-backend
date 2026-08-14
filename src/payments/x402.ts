import { Prisma } from "@prisma/client";
import { x402Config } from "../config/x402.js";
import { creditAccount as defaultCreditAccount } from "./credits.js";
import { mdlnMultiplier as defaultMdlnMultiplier } from "./mdln.js";
import { isWalletLinkedToAccount as defaultIsWalletLinkedToAccount } from "../utils/account.js";
import type { CreditInput } from "./credits.js";
import type { PaymentRequirement, PaymentScheme, X402Payload } from "./schemes/types.js";

export interface SettleDeps {
  creditAccount: (input: CreditInput) => Promise<void>;
  mdlnMultiplier: (address: string) => Promise<number>;
  isWalletLinkedToAccount: typeof defaultIsWalletLinkedToAccount;
}

export interface PaymentRequiredBody {
  x402Version: 1;
  accepts: PaymentRequirement[];
  error?: string;
}

export function encodePaymentHeader(p: X402Payload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodePaymentHeader(header: string): X402Payload | null {
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (
      json &&
      typeof json.scheme === "string" &&
      typeof json.network === "string" &&
      typeof json.txHash === "string" &&
      typeof json.nonce === "string"
    ) {
      return json as X402Payload;
    }
    return null;
  } catch {
    return null;
  }
}

export function priceAtomic(costCredits: number): bigint {
  return BigInt(costCredits) * x402Config.usdcAtomicPerCredit;
}

export function buildPaymentRequired(
  schemes: PaymentScheme[],
  args: { costCredits: number; resource: string; nonce: string; error?: string },
): PaymentRequiredBody {
  const amountAtomic = priceAtomic(args.costCredits);
  return {
    x402Version: 1,
    accepts: schemes.map((s) => s.buildRequirement({ amountAtomic, resource: args.resource, nonce: args.nonce })),
    ...(args.error ? { error: args.error } : {}),
  };
}

export interface SettleResult {
  ok: boolean;
  creditedAmount?: number;
  reason?: string;
}

export interface SettlementTarget {
  id: string;
  accountId: string;
}

export async function settlePayment(
  scheme: PaymentScheme,
  apiClient: SettlementTarget,
  payload: X402Payload,
  deps: SettleDeps = {
    creditAccount: defaultCreditAccount,
    mdlnMultiplier: defaultMdlnMultiplier,
    isWalletLinkedToAccount: defaultIsWalletLinkedToAccount,
  },
): Promise<SettleResult> {
  const v = await scheme.verify(payload);
  if (!v.ok || v.amountAtomic === undefined || !v.proofNonce) {
    return { ok: false, reason: v.reason ?? "payment verification failed" };
  }

  if (!v.payer || !(await deps.isWalletLinkedToAccount(apiClient.accountId, "STARKNET", v.payer))) {
    return {
      ok: false,
      reason: "payer wallet is not linked to this account — link it via POST /v1/users/me, then fund from that wallet",
    };
  }

  const baseCredits = Number(v.amountAtomic / x402Config.usdcAtomicPerCredit);

  const multiplier = v.payer ? await deps.mdlnMultiplier(v.payer) : 1.0;
  const creditedAmount = Math.floor(baseCredits * multiplier);

  try {
    await deps.creditAccount({
      apiClientId: apiClient.id,
      accountId: apiClient.accountId,
      amountAtomic: v.amountAtomic,
      creditedAmount,
      mdlnMultiplier: multiplier,
      scheme: scheme.scheme,
      network: scheme.network,
      asset: x402Config.usdcContract,
      txHash: payload.txHash,
      proofNonce: v.proofNonce,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: true, creditedAmount: 0, reason: "already credited" };
    }
    throw err;
  }
  return { ok: true, creditedAmount };
}
