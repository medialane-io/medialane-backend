import prisma from "../../db/client.js";
import { Prisma } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import { callRpc, normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import { tokenByAddress, usdcEquivalentAtomic } from "../../payments/token-value.js";
import { priceAt as defaultPriceAt } from "../../utils/usdPrices.js";
import { getBlockTimestamp as defaultBlockTimestamp } from "../../utils/blockTimestamp.js";
import { mdlnMultiplier as defaultMdlnMultiplier } from "../../payments/mdln.js";
import {
  creditAccount as defaultCreditAccount,
  settleUnattributedPayment as defaultSettleUnattributed,
} from "../../payments/credits.js";
import { x402Config } from "../../config/x402.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import { parseDepositEvents, depositNonce, type DepositEvent } from "../../funding/deposits.js";

export { parseDepositEvents, depositNonce, type DepositEvent };

const log = createLogger("mirror:treasury-deposit");

export interface CreditedPayment {
  paymentId: string;
  apiClientId: string;
}

export interface ExistingPayment {
  paymentId: string;
  apiClientId: string | null;
}

const asCredited = (payment: ExistingPayment | null): CreditedPayment | null =>
  payment?.apiClientId ? { paymentId: payment.paymentId, apiClientId: payment.apiClientId } : null;

export interface DepositDeps {
  resolveApiClient: (payer: string) => Promise<{ id: string; accountId: string } | null>;
  recordUnattributed: (input: {
    payer: string;
    asset: string;
    amountAtomic: bigint;
    txHash: string;
    nonce: string;
  }) => Promise<void>;
  existingPayment: (nonce: string) => Promise<ExistingPayment | null>;
  priceAt: typeof defaultPriceAt;
  blockTimestamp: typeof defaultBlockTimestamp;
  mdlnMultiplier: typeof defaultMdlnMultiplier;
  creditAccount: typeof defaultCreditAccount;
  settleUnattributed: typeof defaultSettleUnattributed;
}

export async function creditDeposit(deposit: DepositEvent, deps: DepositDeps): Promise<CreditedPayment | null> {
  const nonce = depositNonce(deposit.txHash, deposit.depositIndex);
  const existing = await deps.existingPayment(nonce);
  if (existing?.apiClientId) return asCredited(existing);

  const token = tokenByAddress(deposit.token);
  if (!token) return null;

  const apiClient = await deps.resolveApiClient(deposit.payer);
  if (!apiClient) {
    await deps.recordUnattributed({
      payer: deposit.payer,
      asset: deposit.token,
      amountAtomic: deposit.amountAtomic,
      txHash: deposit.txHash,
      nonce,
    });
    log.warn(
      { txHash: deposit.txHash, payer: deposit.payer, symbol: token.symbol },
      "Treasury deposit from a wallet with no API client — recorded, not credited",
    );
    return null;
  }

  const at = await deps.blockTimestamp(deposit.blockNumber);
  const price = await deps.priceAt(token.symbol, at);
  if (price === null) {
    throw new Error(
      `No ${token.symbol} price at block ${deposit.blockNumber} while crediting ${deposit.txHash} — retrying rather than crediting wrongly`,
    );
  }

  const valued = usdcEquivalentAtomic(deposit.amountAtomic, token.decimals, price);
  if (valued === null) {
    throw new Error(`Could not value ${deposit.txHash} — retrying`);
  }

  const multiplier = await deps.mdlnMultiplier(deposit.payer);
  const creditedAmount = Math.floor(
    Number(valued / x402Config.usdcAtomicPerCredit) * multiplier,
  );

  const credit = {
    payer: deposit.payer,
    apiClientId: apiClient.id,
    accountId: apiClient.accountId,
    amountAtomic: valued,
    creditedAmount,
    mdlnMultiplier: multiplier,
    scheme: "starknet-transfer",
    network: "starknet",
    asset: deposit.token,
    txHash: deposit.txHash,
    proofNonce: nonce,
  };

  if (existing) {
    const settled = await deps.settleUnattributed(credit);
    if (settled) {
      log.info(
        { txHash: deposit.txHash, apiClient: apiClient.id, creditedAmount, symbol: token.symbol },
        "Treasury deposit credited once its payer had an account",
      );
    }
    return asCredited(await deps.existingPayment(nonce));
  }

  try {
    await deps.creditAccount(credit);
    log.info(
      { txHash: deposit.txHash, apiClient: apiClient.id, creditedAmount, symbol: token.symbol },
      "Treasury deposit credited",
    );
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  return asCredited(await deps.existingPayment(nonce));
}

const productionDeps: DepositDeps = {
  resolveApiClient: async (payer) => {
    const identity = await prisma.identity.findUnique({
      where: { chain_address: { chain: "STARKNET", address: payer } },
      select: { accountId: true, scheme: true },
    });
    if (!identity || identity.scheme !== IDENTITY_SCHEME.WALLET) return null;
    const apiClient = await prisma.apiClient.findUnique({
      where: { accountId: identity.accountId },
      select: { id: true, accountId: true },
    });
    return apiClient ?? null;
  },
  recordUnattributed: async (input) => {
    await prisma.payment
      .create({
        data: {
          payer: input.payer,
          scheme: "starknet-transfer",
          network: "starknet",
          asset: input.asset,
          amountAtomic: input.amountAtomic.toString(),
          creditedAmount: 0,
          status: "UNATTRIBUTED",
          txHash: input.txHash,
          proofNonce: input.nonce,
        },
      })
      .catch(() => {});
  },
  existingPayment: async (nonce) => {
    const payment = await prisma.payment.findUnique({
      where: { proofNonce: nonce },
      select: { id: true, apiClientId: true },
    });
    return payment ? { paymentId: payment.id, apiClientId: payment.apiClientId } : null;
  },
  priceAt: defaultPriceAt,
  blockTimestamp: defaultBlockTimestamp,
  mdlnMultiplier: defaultMdlnMultiplier,
  creditAccount: defaultCreditAccount,
  settleUnattributed: defaultSettleUnattributed,
};

export async function applyTreasuryDeposits(events: RawStarknetEvent[]): Promise<void> {
  if (!x402Config.treasury) return;
  for (const deposit of parseDepositEvents(events, x402Config.treasury)) {
    await creditDeposit(deposit, productionDeps);
  }
}

export async function creditFromTransaction(
  txHash: string,
  deps: DepositDeps = productionDeps,
  fetchReceipt: (hash: string) => Promise<{ events?: RawStarknetEvent[] }> = defaultFetchReceipt,
): Promise<{ credited: number; payments: CreditedPayment[] }> {
  if (!x402Config.treasury) return { credited: 0, payments: [] };

  const receipt = await fetchReceipt(normalizeHash(txHash));
  const deposits = parseDepositEvents(receipt.events ?? [], x402Config.treasury);

  let credited = 0;
  const payments: CreditedPayment[] = [];
  for (const deposit of deposits) {
    const payment = await creditDeposit(deposit, deps);
    if (payment) payments.push(payment);
    credited += 1;
  }
  return { credited, payments };
}

async function defaultFetchReceipt(hash: string): Promise<{ events?: RawStarknetEvent[] }> {
  return callRpc((provider) =>
    (provider as { getTransactionReceipt: (h: string) => Promise<{ events?: RawStarknetEvent[] }> })
      .getTransactionReceipt(hash),
  );
}
