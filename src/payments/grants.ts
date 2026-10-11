import prisma from "../db/client.js";
import { ensureApiCredits } from "../utils/account.js";
import { grant } from "./ledger.js";

export async function grantToAccount(publicId: string, credits: number, reason: string, operator: string) {
  if (!Number.isInteger(credits) || credits <= 0) throw new Error("credits must be a positive whole number");
  if (!reason.trim()) throw new Error("a reason is required");
  const account = await prisma.account.findUnique({ where: { publicId }, select: { id: true } });
  if (!account) throw new Error(`no account with publicId ${publicId}`);
  const apiCredits = await ensureApiCredits(account.id);
  await grant(apiCredits.id, credits, `${reason.trim()} (by ${operator})`);
  const after = await prisma.apiCredits.findUniqueOrThrow({ where: { id: apiCredits.id }, select: { creditBalance: true } });
  return { apiCreditsId: apiCredits.id, creditBalance: after.creditBalance };
}
