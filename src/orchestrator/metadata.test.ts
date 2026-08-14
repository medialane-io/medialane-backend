import { describe, expect, test } from "bun:test";

function mapMetadataForToken(metadata: Record<string, unknown> | null) {
  return {
    name: metadata?.name ?? null,
    description: metadata?.description ?? null,
    image: metadata?.image ?? null,
    animationUrl: metadata?.animation_url ?? null,
  };
}

describe("metadata -> Token field mapping", () => {
  test("maps animation_url to animationUrl", () => {
    const mapped = mapMetadataForToken({
      name: "Lifeform 1",
      image: "data:image/svg+xml;base64,AAAA",
      animation_url: "data:text/html;base64,BBBB",
    });
    expect(mapped.animationUrl).toBe("data:text/html;base64,BBBB");
  });

  test("null metadata maps animationUrl to null", () => {
    expect(mapMetadataForToken(null).animationUrl).toBeNull();
  });

  test("metadata without animation_url maps to null", () => {
    expect(mapMetadataForToken({ name: "x", image: "y" }).animationUrl).toBeNull();
  });
});
