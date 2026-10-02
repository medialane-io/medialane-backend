import { buildAssetMetadata } from "@medialane/sdk";
import { RUN_BATCH_SIZE } from "../../steps.js";
import { canSubmit, isInFlight, pinnedValue, type Pinned, type StepState } from "../data-tokenization/progress.js";
import type { CertificateEmissionSpec } from "./definition.js";

export interface CertificateEmissionProgress {
  collection?: { baseUri?: string; tx?: StepState; address?: string };
  artwork?: Pinned;
  tokenUri?: Pinned;
  /** Guest email to the wallet address it resolves to, or a reservation while that wallet is being deployed. */
  wallets: Record<string, Pinned>;
  batches: Record<string, StepState>;
}

export type NextStep =
  | { kind: "collection" }
  | { kind: "wait-collection" }
  | { kind: "upload"; files: string[] }
  | { kind: "certificate-metadata" }
  | { kind: "wallets" }
  | { kind: "batch"; index: number }
  | { kind: "wait"; index: number }
  | { kind: "done" };

export function readProgress(raw: unknown): CertificateEmissionProgress {
  const p = (raw ?? {}) as Partial<CertificateEmissionProgress>;
  return { ...p, wallets: p.wallets ?? {}, batches: p.batches ?? {} };
}

export function runInFlight(progress: CertificateEmissionProgress): boolean {
  return (
    isInFlight(progress.collection?.tx) ||
    Object.values(progress.wallets).some((w) => typeof w !== "string") ||
    Object.values(progress.batches).some(isInFlight)
  );
}

export function collectionAddressOf(spec: CertificateEmissionSpec, progress: CertificateEmissionProgress): string | null {
  if (spec.collection.kind === "existing") return spec.collection.contractAddress;
  return progress.collection?.address ?? null;
}

export function batchCount(spec: CertificateEmissionSpec): number {
  return Math.ceil(spec.guests.length / RUN_BATCH_SIZE);
}

export function batchGuests(spec: CertificateEmissionSpec, index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= batchCount(spec)) return [];
  return spec.guests.slice(index * RUN_BATCH_SIZE, (index + 1) * RUN_BATCH_SIZE);
}

export function certificateMetadata(spec: CertificateEmissionSpec, progress: CertificateEmissionProgress, creator: string) {
  const imageUri = spec.artwork ? pinnedValue(progress.artwork) : null;
  if (spec.artwork && !imageUri) throw new Error("The certificate is waiting for its artwork");
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
  });
}

export function nextStep(spec: CertificateEmissionSpec, progress: CertificateEmissionProgress): NextStep {
  if (spec.collection.kind === "new" && !progress.collection?.address) {
    return isInFlight(progress.collection?.tx) ? { kind: "wait-collection" } : { kind: "collection" };
  }
  if (spec.artwork && !pinnedValue(progress.artwork)) return { kind: "upload", files: [spec.artwork.name] };
  if (!pinnedValue(progress.tokenUri)) return { kind: "certificate-metadata" };
  if (spec.guests.some((guest) => !pinnedValue(progress.wallets[guest]))) return { kind: "wallets" };

  for (let index = 0; index < batchCount(spec); index++) {
    const batch = progress.batches[String(index)];
    if (canSubmit(batch)) return { kind: "batch", index };
    if (isInFlight(batch)) return { kind: "wait", index };
  }
  return { kind: "done" };
}
