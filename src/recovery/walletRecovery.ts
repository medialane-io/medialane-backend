import type { Call } from "starknet";
import { typedData as starknetTypedData } from "starknet";
import { buildCompleteEscapeOwnerCall, buildTriggerEscapeOwnerCall, computeOwnerGuid, getEscapeSecurityPeriod, getGuardians, getOwners, signWithPrivateKey, sameFelt } from "@medialane/sdk/starknet";
import { accountWallet } from "../utils/account.js";
import { guardianKey, guardianPubkey } from "../utils/guardianKey.js";
import { createProvider } from "../utils/starknet.js";
import { executeOwnSponsoredInvoke } from "../api/routes/paymaster.js";
import { worker } from "../orchestrator/worker.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("recovery");

export interface EscapeState {
  type: "None" | "Guardian" | "Owner";
  status: "None" | "NotReady" | "Ready" | "Expired";
  readyAt: number;
  newSignerKey: string | null;
}

export interface RecoveryDeps {
  walletOf(accountId: string): Promise<string | null>;
  guardianIsOurs(walletAddress: string): Promise<boolean>;
  guardianPubkeyOf(walletAddress: string): string | null;
  ownerGuidsOf(walletAddress: string): Promise<string[]>;
  escapeOf(walletAddress: string): Promise<EscapeState>;
  securityPeriodOf(walletAddress: string): Promise<number>;
  execute(input: { walletAddress: string; calls: Call[] }): Promise<string>;
  waitFor(txHash: string): Promise<void>;
  syncActivity(walletAddress: string): void;
}

export interface RecoveryView {
  enabled: boolean;
  state: "none" | "waiting" | "ready";
  readyAt: number | null;
  securityPeriod: number | null;
  newOwnerGuid: string | null;
  guardianPubkey: string | null;
}

export type RecoveryOutcome =
  | { status: 200; body: RecoveryView }
  | { status: 404 | 409 | 502; error: string };

const ownsWallet = (owners: string[], pubkey: string) => owners.some((guid) => sameFelt(guid, computeOwnerGuid(pubkey)));
const liveOwnerEscape = (escape: EscapeState) => escape.type === "Owner" && (escape.status === "NotReady" || escape.status === "Ready");
const NO_WALLET = { status: 404 as const, error: "This account has no wallet" };
const NOT_ON = { status: 409 as const, error: "Recovery is not turned on for this wallet" };

function offView(guardianPubkey: string | null): RecoveryView {
  return { enabled: false, state: "none", readyAt: null, securityPeriod: null, newOwnerGuid: null, guardianPubkey };
}

function onView(escape: EscapeState, securityPeriod: number): RecoveryView {
  const live = liveOwnerEscape(escape);
  return {
    enabled: true,
    state: !live ? "none" : escape.status === "Ready" ? "ready" : "waiting",
    readyAt: live ? escape.readyAt : null,
    securityPeriod,
    newOwnerGuid: live && escape.newSignerKey ? computeOwnerGuid(escape.newSignerKey) : null,
    guardianPubkey: null,
  };
}

export async function recoveryStatus(deps: RecoveryDeps, accountId: string): Promise<RecoveryOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return NO_WALLET;
  if (!(await deps.guardianIsOurs(walletAddress))) return { status: 200, body: offView(deps.guardianPubkeyOf(walletAddress)) };
  const [escape, period] = await Promise.all([deps.escapeOf(walletAddress), deps.securityPeriodOf(walletAddress)]);
  return { status: 200, body: onView(escape, period) };
}

const NOT_STARTED: EscapeState = { type: "None", status: "None", readyAt: 0, newSignerKey: null };

async function submit(deps: RecoveryDeps, walletAddress: string, call: Call): Promise<string | null> {
  try {
    await deps.waitFor(await deps.execute({ walletAddress, calls: [call] }));
    return null;
  } catch (err) {
    log.warn({ err, walletAddress }, "recovery call could not be sent");
    return "The recovery could not be sent";
  }
}

export async function startRecovery(deps: RecoveryDeps, accountId: string, newOwnerPubkey: string): Promise<RecoveryOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return NO_WALLET;
  if (!(await deps.guardianIsOurs(walletAddress))) return NOT_ON;
  const period = await deps.securityPeriodOf(walletAddress);

  if (ownsWallet(await deps.ownerGuidsOf(walletAddress), newOwnerPubkey)) {
    return { status: 200, body: onView(NOT_STARTED, period) };
  }

  const current = await deps.escapeOf(walletAddress);
  if (liveOwnerEscape(current) && current.newSignerKey !== null && sameFelt(current.newSignerKey, newOwnerPubkey)) {
    return { status: 200, body: onView(current, period) };
  }
  if (current.type === "Guardian" && (current.status === "NotReady" || current.status === "Ready")) {
    return { status: 409, error: "A change to your recovery settings is already in progress. Please try again later." };
  }

  const failure = await submit(deps, walletAddress, buildTriggerEscapeOwnerCall(walletAddress, newOwnerPubkey));
  if (failure) return { status: 502, error: failure };

  const started = await deps.escapeOf(walletAddress);
  if (!liveOwnerEscape(started)) return { status: 502, error: "The recovery could not be started" };
  deps.syncActivity(walletAddress);
  return { status: 200, body: onView(started, period) };
}

export async function completeRecovery(deps: RecoveryDeps, accountId: string, newOwnerPubkey: string): Promise<RecoveryOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return NO_WALLET;
  if (!(await deps.guardianIsOurs(walletAddress))) return NOT_ON;

  const current = await deps.escapeOf(walletAddress);
  if (!liveOwnerEscape(current) || current.newSignerKey === null || !sameFelt(current.newSignerKey, newOwnerPubkey)) {
    return { status: 409, error: "There is no recovery waiting for this key" };
  }
  if (current.status !== "Ready") return { status: 409, error: "The recovery is not ready yet" };

  const failure = await submit(deps, walletAddress, buildCompleteEscapeOwnerCall(walletAddress));
  if (failure) return { status: 502, error: failure };

  if (!ownsWallet(await deps.ownerGuidsOf(walletAddress), newOwnerPubkey)) {
    return { status: 502, error: "The recovery could not be completed" };
  }
  deps.syncActivity(walletAddress);
  const [escape, period] = await Promise.all([deps.escapeOf(walletAddress), deps.securityPeriodOf(walletAddress)]);
  return { status: 200, body: onView(escape, period) };
}

const ESCAPE_TYPES: EscapeState["type"][] = ["None", "Guardian", "Owner"];
const ESCAPE_STATUSES: EscapeState["status"][] = ["None", "NotReady", "Ready", "Expired"];

export function parseEscape(res: string[]): EscapeState {
  const some = Number(res[2]) === 0;
  return {
    type: ESCAPE_TYPES[Number(res[1])] ?? "None",
    status: ESCAPE_STATUSES[Number(res[some ? 5 : 3])] ?? "None",
    readyAt: Number(BigInt(res[0] ?? "0x0")),
    newSignerKey: some ? (res[3] ?? null) : null,
  };
}

export const productionRecoveryDeps: RecoveryDeps = {
  walletOf: (accountId) => accountWallet(accountId),
  guardianPubkeyOf: guardianPubkey,
  guardianIsOurs: async (walletAddress) => {
    try {
      const ours = computeOwnerGuid(guardianKey(walletAddress).publicKey);
      return (await getGuardians(createProvider(), walletAddress)).some((guardian) => sameFelt(guardian.guid, ours));
    } catch {
      return false;
    }
  },
  ownerGuidsOf: async (walletAddress) => (await getOwners(createProvider(), walletAddress)).map((owner) => owner.guid),
  securityPeriodOf: (walletAddress) => getEscapeSecurityPeriod(createProvider(), walletAddress),
  escapeOf: async (walletAddress) =>
    parseEscape(
      (await createProvider().callContract({ contractAddress: walletAddress, entrypoint: "get_escape_and_status", calldata: [] })) as unknown as string[],
    ),
  execute: ({ walletAddress, calls }) =>
    executeOwnSponsoredInvoke({
      userAddress: walletAddress,
      calls,
      sign: (typedData) =>
        signWithPrivateKey(
          guardianKey(walletAddress).privateKey,
          starknetTypedData.getMessageHash(typedData as never, walletAddress),
        ),
    }),
  waitFor: async (txHash) => {
    await createProvider().waitForTransaction(txHash);
  },
  syncActivity: (walletAddress) => worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: walletAddress }),
};
