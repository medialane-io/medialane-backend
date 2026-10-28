import type { Call } from "starknet";
import { typedData as starknetTypedData } from "starknet";
import {
  buildCompleteEscapeOwnerCall,
  buildTriggerEscapeOwnerCall,
  computeOwnerGuid,
  getGuardians,
  getOwners,
  signWithPrivateKey,
} from "@medialane/sdk/starknet";
import { accountWallet } from "../utils/account.js";
import { guardianKey } from "../utils/guardianKey.js";
import { createProvider } from "../utils/starknet.js";
import { executeOwnSponsoredInvoke } from "../api/routes/paymaster.js";

export interface EscapeState {
  type: "None" | "Guardian" | "Owner";
  status: "None" | "NotReady" | "Ready" | "Expired";
  readyAt: number;
  newSignerKey: string | null;
}

export interface RecoveryDeps {
  walletOf(accountId: string): Promise<string | null>;
  guardianIsOurs(walletAddress: string): Promise<boolean>;
  ownerGuidsOf(walletAddress: string): Promise<string[]>;
  escapeOf(walletAddress: string): Promise<EscapeState>;
  execute(input: { walletAddress: string; calls: Call[] }): Promise<string>;
  waitFor(txHash: string): Promise<void>;
}

export interface RecoveryView {
  enabled: boolean;
  state: "none" | "waiting" | "ready";
  readyAt: number | null;
  newOwnerGuid: string | null;
}

export type RecoveryOutcome =
  | { status: 200; body: RecoveryView }
  | { status: 404 | 409 | 502; error: string };

const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);
const ownsWallet = (owners: string[], pubkey: string) => owners.some((guid) => sameFelt(guid, computeOwnerGuid(pubkey)));
const liveOwnerEscape = (escape: EscapeState) => escape.type === "Owner" && (escape.status === "NotReady" || escape.status === "Ready");
const NO_WALLET = { status: 404 as const, error: "This account has no wallet" };
const NOT_ON = { status: 409 as const, error: "Recovery is not turned on for this wallet" };

function viewOf(enabled: boolean, escape: EscapeState): RecoveryView {
  if (!enabled || !liveOwnerEscape(escape)) return { enabled, state: "none", readyAt: null, newOwnerGuid: null };
  return {
    enabled,
    state: escape.status === "Ready" ? "ready" : "waiting",
    readyAt: escape.readyAt,
    newOwnerGuid: escape.newSignerKey ? computeOwnerGuid(escape.newSignerKey) : null,
  };
}

export async function recoveryStatus(deps: RecoveryDeps, accountId: string): Promise<RecoveryOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return NO_WALLET;
  const enabled = await deps.guardianIsOurs(walletAddress);
  return { status: 200, body: viewOf(enabled, enabled ? await deps.escapeOf(walletAddress) : NOT_STARTED) };
}

const NOT_STARTED: EscapeState = { type: "None", status: "None", readyAt: 0, newSignerKey: null };

async function submit(deps: RecoveryDeps, walletAddress: string, call: Call): Promise<string | null> {
  try {
    await deps.waitFor(await deps.execute({ walletAddress, calls: [call] }));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "The recovery could not be sent";
  }
}

export async function startRecovery(deps: RecoveryDeps, accountId: string, newOwnerPubkey: string): Promise<RecoveryOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return NO_WALLET;
  if (!(await deps.guardianIsOurs(walletAddress))) return NOT_ON;

  if (ownsWallet(await deps.ownerGuidsOf(walletAddress), newOwnerPubkey)) {
    return { status: 200, body: viewOf(true, NOT_STARTED) };
  }

  const current = await deps.escapeOf(walletAddress);
  if (liveOwnerEscape(current)) {
    return current.newSignerKey !== null && sameFelt(current.newSignerKey, newOwnerPubkey)
      ? { status: 200, body: viewOf(true, current) }
      : { status: 409, error: "A recovery is already in progress for another key" };
  }
  if (current.type === "Guardian" && (current.status === "NotReady" || current.status === "Ready")) {
    return { status: 409, error: "The owner has started changing the guardian" };
  }

  const failure = await submit(deps, walletAddress, buildTriggerEscapeOwnerCall(walletAddress, newOwnerPubkey));
  if (failure) return { status: 502, error: failure };

  const started = await deps.escapeOf(walletAddress);
  if (!liveOwnerEscape(started)) return { status: 502, error: "The recovery could not be started" };
  return { status: 200, body: viewOf(true, started) };
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
  return { status: 200, body: viewOf(true, await deps.escapeOf(walletAddress)) };
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
  guardianIsOurs: async (walletAddress) => {
    try {
      const ours = computeOwnerGuid(guardianKey(walletAddress).publicKey);
      return (await getGuardians(createProvider(), walletAddress)).some((guardian) => sameFelt(guardian.guid, ours));
    } catch {
      return false;
    }
  },
  ownerGuidsOf: async (walletAddress) => (await getOwners(createProvider(), walletAddress)).map((owner) => owner.guid),
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
};
