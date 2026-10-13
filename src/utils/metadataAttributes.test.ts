import { describe, expect, test } from "bun:test";
import { metadataAttributes } from "./metadataAttributes.js";

describe("metadataAttributes", () => {
  test("reads the attributes array from a metadata document", () => {
    expect(metadataAttributes({ name: "Gala", attributes: [{ trait_type: "Visibility", value: "Private" }] })).toEqual([
      { trait_type: "Visibility", value: "Private" },
    ]);
  });

  test("is null when the document has no attributes, or they are not trait/value pairs", () => {
    expect(metadataAttributes({ name: "Gala" })).toBeNull();
    expect(metadataAttributes(null)).toBeNull();
    expect(metadataAttributes({ attributes: "Private" })).toBeNull();
    expect(metadataAttributes({ attributes: [{ value: "Private" }] })).toBeNull();
  });
});
