import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { collectionImage, newCollectionFields, type NewCollection } from "./collection-metadata.js";
import { parseRunSpec } from "./index.js";

const base: NewCollection = { kind: "new", name: "Archive", symbol: "ARC" };

describe("collectionImage", () => {
  const image = { name: "cover.png", size: 3, type: "image/png" };
  test("is the new collection's image unless another run file has its name", () => {
    expect(collectionImage({ ...base, image }, ["a.png"])).toEqual(image);
    expect(collectionImage({ ...base, image }, ["cover.png"])).toBeNull();
    expect(collectionImage(base, [])).toBeNull();
    expect(collectionImage({ kind: "existing" }, [])).toBeNull();
  });
});

describe("new collection fields", () => {
  const shape = z.object(newCollectionFields);
  test("accept the app's fields and reject a long description or a non-web link", () => {
    expect(
      shape.parse({ name: "A", symbol: "A", description: "d", externalLink: "https://x.example", image: { name: "c.png", size: 1, type: "image/png" } })
        .description,
    ).toBe("d");
    expect(() => shape.parse({ name: "A", symbol: "A", description: "x".repeat(501) })).toThrow();
    expect(() => shape.parse({ name: "A", symbol: "A", externalLink: "ftp://x.example" })).toThrow();
  });

  test("every run service accepts them on a new collection", () => {
    const terms = {
      licenseType: "CC BY-SA", commercialUse: "No", derivatives: "Share-Alike",
      attribution: "Required", territory: "Worldwide", aiPolicy: "Allowed", royalty: 0,
    };
    const collection = { kind: "new", name: "A", symbol: "A", description: "d", externalLink: "https://x.example" };
    const tokenization = parseRunSpec("data-tokenization-erc721", {
      collection, terms,
      items: [{ name: "P", ipType: "Art", placement: "image", file: { name: "p.png", size: 1, type: "image/png" } }],
    });
    const ticketing = parseRunSpec("ip-ticketing", { collection, terms: { ...terms, transferable: "Allowed" }, name: "T", guests: ["a@x.com"] });
    const certificate = parseRunSpec("certificate-emission", { collection, terms, name: "C", guests: ["a@x.com"] });
    for (const run of [tokenization, ticketing, certificate]) {
      expect((run.spec as { collection: { description?: string } }).collection.description).toBe("d");
    }
  });
});
