import { describe, expect, test } from "bun:test";
import { ipTicketing } from "./definition.js";
import { batchGuests, nextStep, readProgress, runInFlight, ticketMetadata } from "./progress.js";

const terms = {
  licenseType: "All Rights Reserved", commercialUse: "No", derivatives: "Allowed",
  attribution: "Required", territory: "Worldwide", aiPolicy: "Not Allowed", royalty: 0,
};

const base = {
  collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
  terms: { ...terms, transferable: "Allowed" },
  name: "General admission",
  guests: ["a@x.com", "b@x.com"],
};

const parse = (extra: Record<string, unknown> = {}) => ipTicketing.parseSpec({ ...base, ...extra });
const progress = (p: Record<string, unknown> = {}) => readProgress(p);

describe("the next step of an IP Ticketing run", () => {
  test("a new collection comes first, then waits for its transaction", () => {
    const spec = parse({ collection: { kind: "new", name: "Gala", symbol: "GALA" } });
    expect(nextStep(spec, progress())).toEqual({ kind: "collection" });
    expect(nextStep(spec, progress({ collection: { tx: { status: "SUBMITTED", txHash: "0x1" } } }))).toEqual({
      kind: "wait-collection",
    });
  });

  test("artwork is uploaded before the ticket's metadata is stored", () => {
    const spec = parse({ artwork: { name: "a.png", size: 3, type: "image/png" } });
    expect(nextStep(spec, progress())).toEqual({ kind: "upload", file: "a.png" });
    expect(nextStep(spec, progress({ artwork: "ipfs://art" }))).toEqual({ kind: "metadata" });
  });

  test("the ticket type is created once the metadata is stored, and waited on until it lands", () => {
    const spec = parse();
    expect(nextStep(spec, progress())).toEqual({ kind: "metadata" });
    expect(nextStep(spec, progress({ tokenUri: "ipfs://meta" }))).toEqual({ kind: "tier" });
    expect(
      nextStep(spec, progress({ tokenUri: "ipfs://meta", tier: { tx: { status: "SUBMITTED", txHash: "0x2" } } })),
    ).toEqual({ kind: "wait-tier" });
  });

  test("guest wallets come after the ticket type, then emission batches in order", () => {
    const spec = parse();
    const ticket = { tokenUri: "ipfs://meta", tier: { ticketId: "7", tx: { status: "SUCCEEDED", txHash: "0x2" } } };
    expect(nextStep(spec, progress(ticket))).toEqual({ kind: "wallets" });

    const wallets = { "a@x.com": "0xa", "b@x.com": "0xb" };
    expect(nextStep(spec, progress({ ...ticket, wallets }))).toEqual({ kind: "batch", index: 0 });
    expect(
      nextStep(spec, progress({ ...ticket, wallets, batches: { "0": { status: "SUBMITTED", txHash: "0x3" } } })),
    ).toEqual({ kind: "wait", index: 0 });
    expect(
      nextStep(spec, progress({ ...ticket, wallets, batches: { "0": { status: "SUCCEEDED", txHash: "0x3" } } })),
    ).toEqual({ kind: "done" });
  });

  test("a wallet that is still being deployed keeps the wallets step open", () => {
    const spec = parse();
    const ticket = { tokenUri: "ipfs://meta", tier: { ticketId: "7", tx: { status: "SUCCEEDED", txHash: "0x2" } } };
    expect(nextStep(spec, progress({ ...ticket, wallets: { "a@x.com": "0xa", "b@x.com": { status: "PENDING" } } }))).toEqual({
      kind: "wallets",
    });
  });
});

describe("what is in flight", () => {
  test("a run cannot be cancelled while a transaction or a wallet is pending", () => {
    expect(runInFlight(progress())).toBe(false);
    expect(runInFlight(progress({ collection: { tx: { status: "SUBMITTED", txHash: "0x1" } } }))).toBe(true);
    expect(runInFlight(progress({ tier: { tx: { status: "PENDING" } } }))).toBe(true);
    expect(runInFlight(progress({ wallets: { "a@x.com": { status: "PENDING" } } }))).toBe(true);
    expect(runInFlight(progress({ batches: { "0": { status: "SUBMITTED", txHash: "0x3" } } }))).toBe(true);
    expect(runInFlight(progress({ batches: { "0": { status: "REVERTED", txHash: "0x3" } } }))).toBe(false);
  });

  test("the definition reports it the same way", () => {
    expect(ipTicketing.inFlight({ tier: { tx: { status: "PENDING" } } })).toBe(true);
    expect(ipTicketing.inFlight({})).toBe(false);
  });
});

describe("a fresh run's progress", () => {
  test("has every parent object a step is recorded under, because the database only fills in the last key of a path", () => {
    const fresh = ipTicketing.initialProgress() as Record<string, unknown>;
    for (const parent of ["collection", "tier", "wallets", "batches"]) expect(fresh[parent]).toEqual({});
  });
});

describe("batches and metadata", () => {
  test("guests go out in batches of 25", () => {
    const guests = Array.from({ length: 60 }, (_, i) => `g${i}@x.com`);
    const spec = parse({ guests });
    expect(batchGuests(spec, 0)).toHaveLength(25);
    expect(batchGuests(spec, 2)).toHaveLength(10);
    expect(batchGuests(spec, 3)).toEqual([]);
  });

  test("the ticket's metadata carries its name, the artwork and the licensing terms", () => {
    const spec = parse({
      description: "Doors at 8",
      artwork: { name: "a.png", size: 3, type: "image/png" },
      terms: { ...terms, aiPolicy: "Allowed", derivatives: "Share-Alike", transferable: "Not Allowed", royalty: 5 },
    });
    const metadata = ticketMetadata(spec, progress({ artwork: "ipfs://art" }), "0xabc");
    expect(metadata.name).toBe("General admission");
    expect(metadata.description).toBe("Doors at 8");
    expect(metadata.image).toBe("ipfs://art");
    expect(JSON.stringify(metadata)).toContain("Share-Alike");
  });

  test("metadata waits for the artwork when the spec has one", () => {
    const spec = parse({ artwork: { name: "a.png", size: 3, type: "image/png" } });
    expect(() => ticketMetadata(spec, progress(), "0xabc")).toThrow();
  });
});
