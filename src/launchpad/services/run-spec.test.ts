import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";
import { MAX_RUN_ITEMS } from "../steps.js";
import { parseRunSpec } from "./index.js";

const terms = {
  licenseType: "CC BY-SA",
  commercialUse: "Yes",
  derivatives: "Share-Alike",
  attribution: "Required",
  territory: "Worldwide",
  aiPolicy: "Allowed",
  royalty: 0,
};

const item = (n: number) => ({
  name: `Item ${n}`,
  ipType: "Documents",
  placement: "document",
  file: { name: `item-${n}.pdf`, size: 1024, type: "application/pdf" },
  image: { name: "cover.png", size: 2048, type: "image/png" },
});

const catalog = (items: unknown[]) => ({
  collection: { kind: "existing", collectionId: "3", contractAddress: "0xabc" },
  terms,
  items,
});

describe("data tokenization runs", () => {
  test("a catalog with a collection, terms and items is accepted", () => {
    const run = parseRunSpec("data-tokenization-erc721", catalog([item(1), item(2)]));
    expect(run.service).toBe("data-tokenization-erc721");
    if (run.service === "data-tokenization-erc721") {
      expect(run.spec.items).toHaveLength(2);
      expect(run.spec.items[0]!.traits).toEqual([]);
    }
  });

  test("items can share a cover image", () => {
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([item(1), item(2)]))).not.toThrow();
  });

  test("two items pointing at the same file are refused", () => {
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([item(1), item(1)]))).toThrow();
  });

  test("an item keeps its name, description and any number of traits whatever their length", () => {
    const name = "t".repeat(500);
    const description = "d".repeat(10_000);
    const traits = Array.from({ length: 50 }, (_, i) => ({ traitType: `trait ${i}`, value: `value ${i}` }));
    const run = parseRunSpec("data-tokenization-erc721", catalog([{ ...item(1), name, description, traits }]));
    if (run.service === "data-tokenization-erc721") {
      expect(run.spec.items[0]!.name).toBe(name);
      expect(run.spec.items[0]!.description).toBe(description);
      expect(run.spec.items[0]!.traits).toHaveLength(50);
    }
  });

  test("license terms are kept as written", () => {
    const written = { licenseType: "Ambrosia", commercialUse: "Negotiable", derivatives: "Ask first", attribution: "Link", territory: "Brasil", aiPolicy: "Cite", royalty: 100 };
    const run = parseRunSpec("data-tokenization-erc721", { ...catalog([item(1)]), terms: written });
    if (run.service === "data-tokenization-erc721") expect(run.spec.terms).toEqual(written);
  });

  test("a trait keeps its name and value whatever their length", () => {
    const longName = "n".repeat(200);
    const longValue = "v".repeat(100_000);
    const run = parseRunSpec("data-tokenization-erc721", catalog([{ ...item(1), traits: [{ traitType: longName, value: longValue }] }]));
    if (run.service === "data-tokenization-erc721") {
      expect(run.spec.items[0]!.traits).toEqual([{ traitType: longName, value: longValue }]);
    }
  });

  test("a file of the upload size is accepted", () => {
    const full = { ...item(1), file: { name: "full.pdf", size: MAX_UPLOAD_BYTES, type: "application/pdf" } };
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([full]))).not.toThrow();
  });

  test("a file over the upload limit is refused", () => {
    const big = { ...item(1), file: { name: "big.pdf", size: MAX_UPLOAD_BYTES + 1, type: "application/pdf" } };
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([big]))).toThrow();
  });

  test("a catalog larger than one run is refused", () => {
    const items = Array.from({ length: MAX_RUN_ITEMS + 1 }, (_, i) => item(i));
    expect(() => parseRunSpec("data-tokenization-erc721", catalog(items))).toThrow();
  });

  test("a document or media item without a cover is refused", () => {
    const { image, ...withoutCover } = item(1);
    expect(image).toBeDefined();
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([withoutCover]))).toThrow();
  });

  test("an image item needs no cover but its file has to be an image", () => {
    const picture = { name: "Photo", ipType: "Photography", placement: "image", file: { name: "p.jpg", size: 10, type: "image/jpeg" } };
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([picture]))).not.toThrow();
    const notPicture = { ...picture, file: { name: "p.pdf", size: 10, type: "application/pdf" } };
    expect(() => parseRunSpec("data-tokenization-erc721", catalog([notPicture]))).toThrow();
  });
});

describe("ip ticketing runs", () => {
  const tickets = {
    collection: { kind: "new", name: "Summer", symbol: "SUM" },
    terms: { ...terms, transferable: "Allowed" },
    name: "Opening night",
    guests: ["A@example.com", "a@example.com", "b@example.com"],
  };

  test("guests are deduplicated regardless of case", () => {
    const run = parseRunSpec("ip-ticketing", tickets);
    if (run.service === "ip-ticketing") expect(run.spec.guests).toEqual(["a@example.com", "b@example.com"]);
  });

  test("a supply smaller than the guest list is refused", () => {
    expect(() => parseRunSpec("ip-ticketing", { ...tickets, supply: 1 })).toThrow();
  });

  test("a validity window that ends before it starts is refused", () => {
    expect(() => parseRunSpec("ip-ticketing", { ...tickets, validFrom: 2000, validUntil: 1000 })).toThrow();
  });
});

test("an unknown service is refused", () => {
  expect(() => parseRunSpec("pop-protocol", {})).toThrow();
});
