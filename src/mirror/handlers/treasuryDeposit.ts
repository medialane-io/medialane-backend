import prisma from "../../db/client.js";
import { Prisma } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import { normalizeAddress, normalizeHash } from "../../utils/starknet.js";
import { tokenByAddress, usdcEquivalentAtomic } from "../../payments/token-value.js";
import { readUsdPrices as defaultReadUsdPrices } from "../../utils/usdPrices.js";
import { mdlnMultiplier as defaultMdlnMultiplier } from "../../payments/mdln.js";
import { creditAccount as defaultCreditAccount } from "../../payments/credits.js";
import { x402Config } from "../../config/x402.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:treasury-deposit");

export interface DepositEvent {
  txHash: string;
  token: string;
  amountAtomic: bigint;
  payer: string;
}

export function parseDepositEvents(
  events: RawStarknetEvent[],
  treasury: string,
): DepositEvent[] {
  const to = normalizeAddress("STARKNET", treasury);
  const out: DepositEvent[] = [];

  for (const ev of events) {
    const token = tokenByAddress(ev.from_address);
    if (!token) continue;
    if (!ev.keys?.[2] || normalizeAddress("STARKNET", ev.keys[2]) !== to) continue;
    if (!ev.keys[1] || !ev.data?.[0]) continue;

    const low = BigInt(ev.data[0]);
    const high = ev.data[1] ? BigInt(ev.data[1]) : 0n;
    const amountAtomic = low + (high << 128n);
    if (amountAtomic === 0n) continue;

    out.push({
      txHash: normalizeHash(ev.transaction_hash),
      token: normalizeAddress("STARKNET", token.address),
      amountAtomic,
      payer: normalizeAddress("STARKNET", ev.keys[1]),
    });
  }

  return out;
}

export interface DepositDeps {
  resolveApiClient: (payer: string) => Promise<{ id: string; accountId: string } | null>;
  alreadyCredited: (txHash: string) => Promise<boolean>;
  readUsdPrices: typeof defaultReadUsdPrices;
  mdlnMultiplier: typeof defaultMdlnMultiplier;
  creditAccount: typeof defaultCreditAccount;
}

export async function creditDeposit(deposit: DepositEvent, deps: DepositDeps): Promise<void> {
  if (await deps.alreadyCredited(deposit.txHash)) return;

  const apiClient = await deps.resolveApiClient(deposit.payer);
  if (!apiClient) {
    log.warn(
      { txHash: deposit.txHash, payer: deposit.payer, amountAtomic: deposit.amountAtomic.toString() },
      "Treasury deposit from a wallet with no API client — left uncredited",
    );
    return;
  }

  const token = tokenByAddress(deposit.token);
  if (!token) return;

  const prices = await deps.readUsdPrices();
  const price = prices?.[token.symbol as keyof typeof prices];
  if (price === undefined) {
    throw new Error(
      `No ${token.symbol} price while crediting ${deposit.txHash} — retrying rather than crediting wrongly`,
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

  try {
    await deps.creditAccount({
      apiClientId: apiClient.id,
      accountId: apiClient.accountId,
      amountAtomic: valued,
      creditedAmount,
      mdlnMultiplier: multiplier,
      scheme: "starknet-transfer",
      network: "starknet",
      asset: deposit.token,
      txHash: deposit.txHash,
      proofNonce: deposit.txHash,
    });
    log.info(
      { txHash: deposit.txHash, apiClient: apiClient.id, creditedAmount, symbol: token.symbol },
      "Treasury deposit credited",
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
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
  alreadyCredited: async (txHash) =>
    (await prisma.payment.findUnique({ where: { proofNonce: txHash }, select: { id: true } })) !== null,
  readUsdPrices: defaultReadUsdPrices,
  mdlnMultiplier: defaultMdlnMultiplier,
  creditAccount: defaultCreditAccount,
};

export async function applyTreasuryDeposits(events: RawStarknetEvent[]): Promise<void> {
  if (!x402Config.treasury) return;
  for (const deposit of parseDepositEvents(events, x402Config.treasury)) {
    await creditDeposit(deposit, productionDeps);
  }
}
