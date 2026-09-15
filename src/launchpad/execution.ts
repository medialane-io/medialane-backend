import { buildAssetMetadata } from "@medialane/sdk";
import { RUN_BATCH_SIZE } from "./quote.js";
import type { DataTokenizationSpec } from "./run-spec.js";

export const PENDING = "pending";
export const DOCUMENT_TRAIT = "Document File";

export type BatchStatus = "SUBMITTED" | "SUCCEEDED" | "REVERTED";

export interface TxState {
  txHash: string;
  status: BatchStatus;
}

export interface CollectionProgress {
  baseUri?: string;
  tx?: TxState | typeof PENDING;
  collectionId?: string;
}

export interface DataTokenizationProgress {
  files: Record<string, string>;
  uploadUrls: Record<string, number>;
  tokenUris: Record<string, string>;
  batches: Record<string, TxState | typeof PENDING>;
  collection?: CollectionProgress;
}

export type NextStep =
  | { kind: "collection" }
  | { kind: "wait-collection" }
  | { kind: "upload"; files: string[] }
  | { kind: "metadata"; items: number[] }
  | { kind: "batch"; index: number }
  | { kind: "wait"; index: number }
  | { kind: "done" };

export function emptyProgress(): DataTokenizationProgress {
  return { files: {}, uploadUrls: {}, tokenUris: {}, batches: {} };
}

export function readProgress(raw: unknown): DataTokenizationProgress {
  const p = (raw ?? {}) as Partial<DataTokenizationProgress>;
  return {
    files: p.files ?? {},
    uploadUrls: p.uploadUrls ?? {},
    tokenUris: p.tokenUris ?? {},
    batches: p.batches ?? {},
    collection: p.collection,
  };
}

export function isInFlight(state: TxState | typeof PENDING | undefined): boolean {
  return state === PENDING || (typeof state === "object" && state.status === "SUBMITTED");
}

export function canSubmit(state: TxState | typeof PENDING | undefined): boolean {
  return state === undefined || (typeof state === "object" && state.status === "REVERTED");
}

export function collectionIdOf(spec: DataTokenizationSpec, progress: DataTokenizationProgress): string | null {
  if (spec.collection.kind === "existing") return spec.collection.collectionId;
  return progress.collection?.collectionId ?? null;
}

export interface ExpectedFile {
  size: number;
  type: string;
}

export function expectedFiles(spec: DataTokenizationSpec): Map<string, ExpectedFile> {
  const files = new Map<string, ExpectedFile>();
  for (const item of spec.items) {
    files.set(item.file.name, { size: item.file.size, type: item.file.type });
    if (item.image) files.set(item.image.name, { size: item.image.size, type: item.image.type });
  }
  return files;
}

export function expectedFile(spec: DataTokenizationSpec, name: string): ExpectedFile | null {
  return expectedFiles(spec).get(name) ?? null;
}

export function uploadedUri(progress: DataTokenizationProgress, name: string): string | null {
  const uri = progress.files[name];
  return uri !== undefined && uri !== PENDING ? uri : null;
}

export function batchCount(spec: DataTokenizationSpec): number {
  return Math.ceil(spec.items.length / RUN_BATCH_SIZE);
}

export function itemsInBatch(spec: DataTokenizationSpec, index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= batchCount(spec)) return [];
  const start = index * RUN_BATCH_SIZE;
  const end = Math.min(start + RUN_BATCH_SIZE, spec.items.length);
  return Array.from({ length: end - start }, (_, i) => start + i);
}

const uploaded = uploadedUri;

export function itemMetadata(
  spec: DataTokenizationSpec,
  index: number,
  progress: DataTokenizationProgress,
  creator: string,
): Record<string, unknown> {
  const item = spec.items[index];
  if (!item) throw new Error(`No item ${index} in this run`);
  const fileUri = uploaded(progress, item.file.name);
  const coverUri = item.image ? uploaded(progress, item.image.name) : null;
  if (!fileUri || (item.placement !== "image" && !coverUri)) {
    throw new Error(`Item ${index} is waiting for its files`);
  }

  const templateTraits = [
    ...item.traits,
    ...(item.placement === "document" ? [{ traitType: DOCUMENT_TRAIT, value: fileUri }] : []),
  ];

  const built = buildAssetMetadata({
    name: item.name,
    description: item.description,
    imageUri: item.placement === "image" ? fileUri : coverUri,
    creator,
    ipType: item.ipType,
    licenseType: spec.terms.licenseType,
    commercialUse: spec.terms.commercialUse,
    derivatives: spec.terms.derivatives,
    attribution: spec.terms.attribution,
    geographicScope: spec.terms.territory,
    aiPolicy: spec.terms.aiPolicy,
    royalty: String(spec.terms.royalty),
    templateTraits,
  });

  return item.placement === "animation" ? { ...built, animation_url: fileUri } : { ...built };
}

export function nextStep(spec: DataTokenizationSpec, progress: DataTokenizationProgress): NextStep {
  if (spec.collection.kind === "new" && !progress.collection?.collectionId) {
    return isInFlight(progress.collection?.tx) ? { kind: "wait-collection" } : { kind: "collection" };
  }

  const missing = [...expectedFiles(spec).keys()].filter((name) => !uploaded(progress, name));
  if (missing.length > 0) return { kind: "upload", files: missing };

  const unpinned = spec.items.map((_, i) => i).filter((i) => {
    const uri = progress.tokenUris[String(i)];
    return !uri || uri === PENDING;
  });
  if (unpinned.length > 0) return { kind: "metadata", items: unpinned };

  for (let index = 0; index < batchCount(spec); index++) {
    const batch = progress.batches[String(index)];
    if (canSubmit(batch)) return { kind: "batch", index };
    if (isInFlight(batch)) return { kind: "wait", index };
  }
  return { kind: "done" };
}
