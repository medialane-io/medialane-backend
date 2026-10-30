import { describe, expect, test } from "bun:test";
import { metadataAttributes, tokenFields, withoutNulCharacters } from "./metadataAttributes.js";

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

describe("tokenFields", () => {
  const none = { ipType: null, licenseType: null, commercialUse: null, author: null };

  test("reads each field from properties", () => {
    expect(
      tokenFields({ properties: { ip_type: "Art", license_type: "CC BY", commercial_use: true, author: "Ana" } }, []),
    ).toEqual({ ipType: "Art", licenseType: "CC BY", commercialUse: true, author: "Ana" });
  });

  test("properties win over the top level", () => {
    expect(tokenFields({ properties: { ip_type: "Art" }, ip_type: "Audio" }, []).ipType).toBe("Art");
  });

  test("the top level is used when properties is missing or not an object", () => {
    expect(tokenFields({ ip_type: "Audio", author: "Bo" }, [])).toEqual({ ...none, ipType: "Audio", author: "Bo" });
    expect(tokenFields({ properties: "x", ip_type: "Audio" }, []).ipType).toBe("Audio");
    expect(tokenFields({ properties: ["x"], ip_type: "Audio" }, []).ipType).toBe("Audio");
  });

  test("the trait is the last resort for ip type and license only, matched ignoring case", () => {
    const attrs = [
      { trait_type: "IP Type", value: "Video" },
      { trait_type: "LICENSE", value: "CC0" },
      { trait_type: "Author", value: "Cy" },
    ];
    expect(tokenFields({}, attrs)).toEqual({ ...none, ipType: "Video", licenseType: "CC0" });
    expect(tokenFields({ properties: { ip_type: "Art" } }, attrs).ipType).toBe("Art");
  });

  test("a value of the wrong type is skipped and the next source is used", () => {
    expect(tokenFields({ properties: { ip_type: 5 }, ip_type: "Audio" }, []).ipType).toBe("Audio");
    expect(tokenFields({ properties: { ip_type: 5 } }, [{ trait_type: "ip type", value: "Video" }]).ipType).toBe("Video");
    expect(tokenFields({ commercial_use: "yes" }, []).commercialUse).toBeNull();
    expect(tokenFields({ author: 7 }, []).author).toBeNull();
  });

  test("a matching trait whose value is not text gives null", () => {
    expect(tokenFields({}, [{ trait_type: "License", value: 3 }]).licenseType).toBeNull();
  });

  test("no metadata gives all null", () => {
    expect(tokenFields(null, [])).toEqual(none);
  });
});

describe("withoutNulCharacters", () => {
  test("removes NUL characters from strings at any depth, keeping everything else", () => {
    expect(
      withoutNulCharacters({
        name: "Relic\u0000 #1",
        attributes: [
          { trait_type: "Glyph", value: "\u0000\u0000\u0000" },
          { trait_type: "Level", value: 3 },
        ],
        hidden: false,
      }),
    ).toEqual({
      name: "Relic #1",
      attributes: [
        { trait_type: "Glyph", value: "" },
        { trait_type: "Level", value: 3 },
      ],
      hidden: false,
    });
  });

  test("passes null through", () => {
    expect(withoutNulCharacters(null)).toBeNull();
  });
});
