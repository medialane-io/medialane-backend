import { buildAssetMetadata } from "@medialane/sdk";
import { RUN_BATCH_SIZE } from "../../steps.js";
import { canSubmit, isInFlight, pinnedValue, type Pinned, type StepState } from "../data-tokenization/progress.js";
import type { IpTicketingSpec } from "./definition.js";

export interface IpTicketingProgress {
  collection?: { baseUri?: string; tx?: StepState; address?: string };
  artwork?: Pinned;
  tokenUri?: Pinned;
  tier?: { tx?: StepState; ticketId?: string };
  /** Guest email to the wallet address it resolves to, or a reservation while that wallet is being deployed. */
  wallets: Record<string, Pinned>;
  batches: Record<string, StepState>;
}

export type NextStep =
  | { kind: "collection" }
  | { kind: "wait-collection" }
  | { kind: "upload"; files: string[] }
  | { kind: "ticket-metadata" }
  | { kind: "tier" }
  | { kind: "wait-tier" }
  | { kind: "wallets" }
  | { kind: "batch"; index: number }
  | { kind: "wait"; index: number }
  | { kind: "done" };

export function readProgress(raw: unknown): IpTicketingProgress {
  const p = (raw ?? {}) as Partial<IpTicketingProgress>;
  return { ...p, wallets: p.wallets ?? {}, batches: p.batches ?? {} };
}

export function runInFlight(progress: IpTicketingProgress): boolean {
  return (
    isInFlight(progress.collection?.tx) ||
    isInFlight(progress.tier?.tx) ||
    Object.values(progress.wallets).some((w) => typeof w !== "string") ||
    Object.values(progress.batches).some(isInFlight)
  );
}

export function collectionAddressOf(spec: IpTicketingSpec, progress: IpTicketingProgress): string | null {
  if (spec.collection.kind === "existing") return spec.collection.contractAddress;
  return progress.collection?.address ?? null;
}

export function batchCount(spec: IpTicketingSpec): number {
  return Math.ceil(spec.guests.length / RUN_BATCH_SIZE);
}

export function batchGuests(spec: IpTicketingSpec, index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= batchCount(spec)) return [];
  return spec.guests.slice(index * RUN_BATCH_SIZE, (index + 1) * RUN_BATCH_SIZE);
}

export function ticketMetadata(spec: IpTicketingSpec, progress: IpTicketingProgress, creator: string) {
  const imageUri = spec.artwork ? pinnedValue(progress.artwork) : null;
  if (spec.artwork && !imageUri) throw new Error("The ticket is waiting for its artwork");
  return buildAssetMetadata({
    name: spec.name,
    description: spec.description,
    imageUri,
    creator,
    ipType: "Other",
    licenseType: spec.terms.licenseType,
    commercialUse: spec.terms.commercialUse,
    derivatives: spec.terms.derivatives,
    attribution: spec.terms.attribution,
    geographicScope: spec.terms.territory,
    aiPolicy: spec.terms.aiPolicy,
    royalty: String(spec.terms.royalty),
  });
}

export function nextStep(spec: IpTicketingSpec, progress: IpTicketingProgress): NextStep {
  if (spec.collection.kind === "new" && !progress.collection?.address) {
    return isInFlight(progress.collection?.tx) ? { kind: "wait-collection" } : { kind: "collection" };
  }
  if (spec.artwork && !pinnedValue(progress.artwork)) return { kind: "upload", files: [spec.artwork.name] };
  if (!pinnedValue(progress.tokenUri)) return { kind: "ticket-metadata" };
  if (!progress.tier?.ticketId) return isInFlight(progress.tier?.tx) ? { kind: "wait-tier" } : { kind: "tier" };
  if (spec.guests.some((guest) => !pinnedValue(progress.wallets[guest]))) return { kind: "wallets" };

  for (let index = 0; index < batchCount(spec); index++) {
    const batch = progress.batches[String(index)];
    if (canSubmit(batch)) return { kind: "batch", index };
    if (isInFlight(batch)) return { kind: "wait", index };
  }
  return { kind: "done" };
}
