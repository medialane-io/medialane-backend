import { describe, expect, test } from "bun:test";
import { certificateEmission } from "./definition.js";
import { batchGuests, nextStep, readProgress } from "./progress.js";

const base = {
  collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
  name: "Course completion",
  guests: ["a@x.com", "b@x.com"],
};

const parse = (extra: Record<string, unknown> = {}) => certificateEmission.parseSpec({ ...base, ...extra });
const progress = (p: Record<string, unknown> = {}) => readProgress(p);

describe("the next step of a Certificate Emission run", () => {
  test("a new collection comes first, then waits for its transaction", () => {
    const spec = parse({ collection: { kind: "new", name: "Cohort 1", symbol: "C1" } });
    expect(nextStep(spec, progress())).toEqual({ kind: "collection" });
    expect(nextStep(spec, progress({ collection: { tx: { status: "SUBMITTED", txHash: "0x1" } } }))).toEqual({
      kind: "wait-collection",
    });
  });

  test("artwork is uploaded before the certificate's metadata is stored", () => {
    const spec = parse({ artwork: { name: "a.png", size: 3, type: "image/png" } });
    expect(nextStep(spec, progress())).toEqual({ kind: "upload", files: ["a.png"] });
    expect(nextStep(spec, progress({ artwork: "ipfs://art" }))).toEqual({ kind: "certificate-metadata" });
  });

  test("wallets come right after metadata — there is no tier step", () => {
    const spec = parse();
    expect(nextStep(spec, progress({ tokenUri: "ipfs://meta" }))).toEqual({ kind: "wallets" });
  });

  test("batches run once every guest has a wallet", () => {
    const spec = parse();
    const withWallets = progress({
      tokenUri: "ipfs://meta",
      wallets: { "a@x.com": "0xa", "b@x.com": "0xb" },
    });
    expect(nextStep(spec, withWallets)).toEqual({ kind: "batch", index: 0 });
    expect(batchGuests(spec, 0)).toEqual(["a@x.com", "b@x.com"]);
  });

  test("done once every batch has succeeded", () => {
    const spec = parse();
    const done = progress({
      tokenUri: "ipfs://meta",
      wallets: { "a@x.com": "0xa", "b@x.com": "0xb" },
      batches: { "0": { status: "SUCCEEDED", txHash: "0x9" } },
    });
    expect(nextStep(spec, done)).toEqual({ kind: "done" });
  });
});
