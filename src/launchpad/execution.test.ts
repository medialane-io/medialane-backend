import { describe, expect, test } from "bun:test";
import { parseRunSpec, type DataTokenizationSpec } from "./run-spec.js";
import { RUN_BATCH_SIZE } from "./quote.js";
import {
  DOCUMENT_TRAIT,
  PENDING,
  batchCount,
  emptyProgress,
  expectedFile,
  itemMetadata,
  itemsInBatch,
  nextStep,
} from "./execution.js";

const CREATOR = "0x0123";

function catalog(items: unknown[]): DataTokenizationSpec {
  const run = parseRunSpec("data-tokenization-erc721", {
    collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
    terms: {
      licenseType: "CC BY-SA",
      commercialUse: "Yes",
      derivatives: "Share-Alike",
      attribution: "Required",
      territory: "Worldwide",
      aiPolicy: "Allowed",
      royalty: 5,
    },
    items,
  });
  if (run.service !== "data-tokenization-erc721") throw new Error("unexpected service");
  return run.spec;
}

const doc = { name: "Report", ipType: "Documents", placement: "document", file: { name: "r.pdf", size: 11, type: "application/pdf" }, image: { name: "c.png", size: 12, type: "image/png" } };
const song = { name: "Song", ipType: "Audio", placement: "animation", file: { name: "s.mp3", size: 13, type: "audio/mpeg" }, image: { name: "c.png", size: 12, type: "image/png" } };
const photo = { name: "Photo", ipType: "Photography", placement: "image", file: { name: "p.jpg", size: 14, type: "image/jpeg" }, traits: [{ traitType: "Camera", value: "X100" }] };

const attr = (metadata: Record<string, unknown>, trait: string) =>
  (metadata.attributes as { trait_type: string; value: string }[]).find((a) => a.trait_type === trait)?.value;

describe("files a run expects", () => {
  test("a file named in the spec carries its declared size and type, and nothing else belongs to the run", () => {
    const spec = catalog([doc, song]);
    expect(expectedFile(spec, "r.pdf")).toEqual({ size: 11, type: "application/pdf" });
    expect(expectedFile(spec, "c.png")).toEqual({ size: 12, type: "image/png" });
    expect(expectedFile(spec, "other.pdf")).toBeNull();
  });
});

describe("item metadata follows the interoperability baseline", () => {
  const progress = {
    ...emptyProgress(),
    files: { "r.pdf": "ipfs://doc", "s.mp3": "ipfs://song", "c.png": "ipfs://cover", "p.jpg": "ipfs://photo" },
  };

  test("a document keeps its cover as the image and its file in the Document File trait", () => {
    const metadata = itemMetadata(catalog([doc]), 0, progress, CREATOR);
    expect(metadata.image).toBe("ipfs://cover");
    expect(metadata.animation_url).toBeUndefined();
    expect(attr(metadata, DOCUMENT_TRAIT)).toBe("ipfs://doc");
  });

  test("audio and video play from animation_url with the cover as the image", () => {
    const metadata = itemMetadata(catalog([song]), 0, progress, CREATOR);
    expect(metadata.image).toBe("ipfs://cover");
    expect(metadata.animation_url).toBe("ipfs://song");
  });

  test("an image is its own cover and keeps its traits and the run's terms", () => {
    const metadata = itemMetadata(catalog([photo]), 0, progress, CREATOR);
    expect(metadata.image).toBe("ipfs://photo");
    expect(attr(metadata, "Camera")).toBe("X100");
    expect(attr(metadata, "License")).toBe("CC BY-SA");
    expect(attr(metadata, "AI Policy")).toBe("Allowed");
    expect(attr(metadata, "Royalty")).toBe("5%");
    expect(attr(metadata, "Creator")).toBe(CREATOR);
  });

  test("metadata waits until the item's files are uploaded", () => {
    const partial = { ...emptyProgress(), files: { "r.pdf": "ipfs://doc", "c.png": PENDING } };
    expect(() => itemMetadata(catalog([doc]), 0, partial, CREATOR)).toThrow();
  });
});

describe("batches and resume", () => {
  const many = Array.from({ length: RUN_BATCH_SIZE + 2 }, (_, i) => ({
    ...photo,
    name: `Photo ${i}`,
    file: { name: `p${i}.jpg`, size: 10, type: "image/jpeg" },
  }));

  test("items split into batches of the run batch size", () => {
    const spec = catalog(many);
    expect(batchCount(spec)).toBe(2);
    expect(itemsInBatch(spec, 0)).toHaveLength(RUN_BATCH_SIZE);
    expect(itemsInBatch(spec, 1)).toEqual([RUN_BATCH_SIZE, RUN_BATCH_SIZE + 1]);
    expect(itemsInBatch(spec, 2)).toEqual([]);
  });

  test("the next step walks uploads, metadata, then each batch, and repeats a reverted one", () => {
    const spec = catalog(many);
    const progress = emptyProgress();
    expect(nextStep(spec, progress).kind).toBe("upload");

    for (const item of many) progress.files[item.file.name] = `ipfs://${item.file.name}`;
    expect(nextStep(spec, progress)).toEqual({ kind: "metadata", items: many.map((_, i) => i) });

    many.forEach((_, i) => (progress.tokenUris[String(i)] = `ipfs://meta${i}`));
    expect(nextStep(spec, progress)).toEqual({ kind: "batch", index: 0 });

    progress.batches["0"] = { txHash: "0x1", status: "SUBMITTED" };
    expect(nextStep(spec, progress)).toEqual({ kind: "wait", index: 0 });

    progress.batches["0"] = { txHash: "0x1", status: "REVERTED" };
    expect(nextStep(spec, progress)).toEqual({ kind: "batch", index: 0 });

    progress.batches["0"] = { txHash: "0x2", status: "SUCCEEDED" };
    progress.batches["1"] = { txHash: "0x3", status: "SUCCEEDED" };
    expect(nextStep(spec, progress)).toEqual({ kind: "done" });
  });
});

describe("runs that create their own collection", () => {
  test("the collection is the first step and waits while its transaction lands", () => {
    const run = parseRunSpec("data-tokenization-erc721", {
      collection: { kind: "new", name: "Archive", symbol: "ARC" },
      terms: {
        licenseType: "CC BY-SA", commercialUse: "Yes", derivatives: "Share-Alike",
        attribution: "Required", territory: "Worldwide", aiPolicy: "Allowed", royalty: 0,
      },
      items: [photo],
    });
    if (run.service !== "data-tokenization-erc721") throw new Error("unexpected service");
    const progress = emptyProgress();
    expect(nextStep(run.spec, progress)).toEqual({ kind: "collection" });

    progress.collection = { baseUri: "ipfs://c", tx: { txHash: "0x1", status: "SUBMITTED" } };
    expect(nextStep(run.spec, progress)).toEqual({ kind: "wait-collection" });

    progress.collection = { baseUri: "ipfs://c", tx: { txHash: "0x1", status: "REVERTED" } };
    expect(nextStep(run.spec, progress)).toEqual({ kind: "collection" });

    progress.collection = { baseUri: "ipfs://c", tx: { txHash: "0x2", status: "SUCCEEDED" }, collectionId: "9" };
    expect(nextStep(run.spec, progress).kind).toBe("upload");
  });
});
