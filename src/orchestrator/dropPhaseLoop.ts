import { Account, type Call } from "starknet";
import prisma from "../db/client.js";
import { createProvider, callRpc } from "../utils/starknet.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:dropPhase");
const POLL_INTERVAL_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

// The platform organizer key (holds ORGANIZER_ROLE on every drop). When unset, the loop
// no-ops — the manage page's "Start public sale now" override still works.
const KEEPER_ADDRESS = process.env.DROP_KEEPER_ADDRESS ?? "";
const KEEPER_PRIVATE_KEY = process.env.DROP_KEEPER_PRIVATE_KEY ?? "";

function u256(value: bigint): [string, string] {
  return [(value & ((1n << 128n) - 1n)).toString(), (value >> 128n).toString()];
}

async function isAllowlistEnabled(collection: string): Promise<boolean> {
  const res = await callRpc((p) => p.callContract({ contractAddress: collection, entrypoint: "is_allowlist_enabled", calldata: [] }));
  return BigInt(res[0] ?? "0x0") !== 0n;
}

async function runTick(account: Account): Promise<void> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const due = await prisma.dropPhaseSchedule.findMany({
    where: { status: "PENDING", transitionAt: { lte: nowSec } },
    take: 20,
  });

  for (const row of due) {
    try {
      // Idempotent: if the creator already transitioned manually (allowlist off), we're done.
      if (!(await isAllowlistEnabled(row.collectionAddress))) {
        await prisma.dropPhaseSchedule.update({ where: { id: row.id }, data: { status: "DONE" } });
        log.info({ id: row.id, collection: row.collectionAddress }, "Phase already public — marked DONE");
        continue;
      }

      // set_claim_conditions(ClaimConditions): start_time, end_time, price(low,high),
      // payment_token, max_quantity_per_wallet(low,high).
      const setConditions: Call = {
        contractAddress: row.collectionAddress,
        entrypoint: "set_claim_conditions",
        calldata: [
          row.publicStartTime.toString(),
          row.publicEndTime.toString(),
          ...u256(BigInt(row.publicPrice)),
          row.publicPaymentToken === "0x0" ? "0" : row.publicPaymentToken,
          ...u256(BigInt(row.publicMaxPerWallet)),
        ],
      };
      const openGate: Call = { contractAddress: row.collectionAddress, entrypoint: "set_allowlist_enabled", calldata: ["0"] };

      const res = await account.execute([setConditions, openGate]);
      await callRpc((p) => p.waitForTransaction(res.transaction_hash));
      await prisma.dropPhaseSchedule.update({ where: { id: row.id }, data: { status: "DONE" } });
      log.info({ id: row.id, collection: row.collectionAddress, tx: res.transaction_hash }, "Drop transitioned to public");
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.dropPhaseSchedule.update({
        where: { id: row.id },
        data: { attempts, status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" },
      });
      log.error({ err, id: row.id, attempts }, "Phase transition failed");
    }
  }
}

export async function startDropPhaseLoop(): Promise<void> {
  if (!KEEPER_ADDRESS || !KEEPER_PRIVATE_KEY) {
    log.warn("DROP_KEEPER_ADDRESS / DROP_KEEPER_PRIVATE_KEY not set — scheduled phase transitions disabled (manual override still works)");
    return;
  }
  const account = new Account(createProvider(), KEEPER_ADDRESS, KEEPER_PRIVATE_KEY, "1");
  log.info({ keeper: KEEPER_ADDRESS }, "Drop phase loop started");
  while (true) {
    try {
      await runTick(account);
    } catch (err) {
      log.error({ err }, "Drop phase loop error");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
