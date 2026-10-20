import { describe, expect, test } from "bun:test";
import { planSharedDescription } from "./share-collection-descriptions.js";

describe("a description every token of a collection carries is stored once", () => {
  test("a collection without a description takes the text its tokens share", () => {
    expect(planSharedDescription({ contractAddress: "0xc", collectionDescription: null, sharedText: "About", tokens: 3 }))
      .toEqual({ contractAddress: "0xc", setCollectionDescription: "About", clearTokens: 3 });
  });

  test("tokens repeating the collection's own description lose their copy", () => {
    expect(planSharedDescription({ contractAddress: "0xc", collectionDescription: "About", sharedText: "About", tokens: 3 }))
      .toEqual({ contractAddress: "0xc", setCollectionDescription: null, clearTokens: 3 });
  });

  test("tokens sharing a text different from the collection's description keep it", () => {
    expect(planSharedDescription({ contractAddress: "0xc", collectionDescription: "Other", sharedText: "About", tokens: 3 }))
      .toBeNull();
  });

  test("an empty collection description counts as none", () => {
    expect(planSharedDescription({ contractAddress: "0xc", collectionDescription: "  ", sharedText: "About", tokens: 2 }))
      .toEqual({ contractAddress: "0xc", setCollectionDescription: "About", clearTokens: 2 });
  });
});
