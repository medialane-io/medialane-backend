import { describe, expect, test } from "bun:test";
import { parseRunSpec } from "./run-spec.js";
import { quoteRun, RUN_BATCH_SIZE } from "./quote.js";

const PRICES: Record<string, number> = {
  "intent:create-collection": 5,
  "metadata:upload-file": 2,
  "metadata:upload-json": 2,
  "intent:mint": 5,
  "intent:create-tier": 5,
  "wallet:deploy": 5,
  "issuance:emission": 5,
  "paymaster:invoke-build": 1,
  "paymaster:invoke-execute": 2,
  "paymaster:deploy-build": 5,
  "paymaster:deploy-execute": 5,
};

const priceOf = async (action: string) => {
  const price = PRICES[action];
  if (price === undefined) throw new Error(`unpriced ${action}`);
  return price;
};

const terms = {
  licenseType: "CC BY-SA",
  commercialUse: "Yes",
  derivatives: "Share-Alike",
  attribution: "Required",
  territory: "Worldwide",
  aiPolicy: "Allowed",
  royalty: 0,
};

const byAction = (lines: { action: string; units: number }[]) =>
  Object.fromEntries(lines.map((l) => [l.action, l.units]));

describe("data tokenization quote", () => {
  const items = Array.from({ length: RUN_BATCH_SIZE + 1 }, (_, i) => ({
    name: `Item ${i}`,
    ipType: "Documents", placement: "document",
    file: { name: `item-${i}.pdf`, size: 10, type: "application/pdf" },
    image: { name: "cover.png", size: 10, type: "image/png" },
  }));

  test("charges each file once, each item's metadata and mint, and gas per batch", async () => {
    const run = parseRunSpec("data-tokenization-erc721", {
      collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
      terms,
      items,
    });
    const quote = await quoteRun(run, { priceOf, countProvisioned: async () => 0 });

    expect(byAction(quote.lines)).toEqual({
      "metadata:upload-file": items.length + 1,
      "metadata:upload-json": items.length,
      "intent:mint": items.length,
      "paymaster:invoke-build": 2,
      "paymaster:invoke-execute": 2,
    });
    expect(quote.total).toBe((items.length + 1) * 2 + items.length * 2 + items.length * 5 + 2 * 1 + 2 * 2);
  });

  test("a new collection adds its creation and its transaction", async () => {
    const run = parseRunSpec("data-tokenization-erc721", {
      collection: { kind: "new", name: "Archive", symbol: "ARC" },
      terms,
      items: items.slice(0, 1),
    });
    const quote = await quoteRun(run, { priceOf, countProvisioned: async () => 0 });
    expect(byAction(quote.lines)["intent:create-collection"]).toBe(1);
    expect(byAction(quote.lines)["paymaster:invoke-execute"]).toBe(2);
  });
});

describe("ip ticketing quote", () => {
  test("only guests without a wallet pay for one", async () => {
    const run = parseRunSpec("ip-ticketing", {
      collection: { kind: "existing", collectionId: "1", contractAddress: "0x1" },
      terms: { ...terms, transferable: "Allowed" },
      name: "Opening night",
      artwork: { name: "art.png", size: 10, type: "image/png" },
      guests: ["a@example.com", "b@example.com", "c@example.com"],
    });
    const quote = await quoteRun(run, { priceOf, countProvisioned: async () => 2 });

    expect(byAction(quote.lines)).toEqual({
      "metadata:upload-file": 1,
      "metadata:upload-json": 1,
      "intent:create-tier": 1,
      "wallet:deploy": 1,
      "paymaster:deploy-build": 1,
      "paymaster:deploy-execute": 1,
      "issuance:emission": 3,
      "paymaster:invoke-build": 2,
      "paymaster:invoke-execute": 2,
    });
    expect(quote.total).toBe(2 + 2 + 5 + 5 + 5 + 5 + 3 * 5 + 2 * 1 + 2 * 2);
  });
});
