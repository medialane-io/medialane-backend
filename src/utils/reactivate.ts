import prisma from "../db/client.js";
import { createLogger } from "./logger.js";

const log = createLogger("utils:reactivate");

export async function reactivateOnWalletProof(accountId: string): Promise<boolean> {
  const { count } = await prisma.account.updateMany({
    where: { id: accountId, status: "SUSPENDED" },
    data: { status: "ACTIVE" },
  });
  if (count === 0) return false;

  log.info({ accountId }, "Reactivated an account for the holder of its wallet");
  return true;
}
