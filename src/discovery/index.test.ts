

import { describe, expect, test } from "bun:test";
import { resolveMetadata } from "./index.js";

describe("resolveMetadata data: URI handling", () => {
  test("resolves a raw (non-base64) data:application/json URI without SSRF false-positive", async () => {
    const uri = `data:application/json,${encodeURIComponent(
      JSON.stringify({ name: "Lifeform 1", animation_url: "data:text/html;base64,AAAA" })
    )}`;
    const result = await resolveMetadata(uri);
    expect(result).toEqual({ name: "Lifeform 1", animation_url: "data:text/html;base64,AAAA" });
  });

  test("resolves a base64 data:application/json URI", async () => {
    const json = JSON.stringify({ name: "Foo" });
    const uri = `data:application/json;base64,${Buffer.from(json, "utf-8").toString("base64")}`;
    expect(await resolveMetadata(uri)).toEqual({ name: "Foo" });
  });
});
