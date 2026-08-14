import { describe, expect, test } from "bun:test";
import { fetchJson } from "./fetcher.js";

describe("fetchJson data: URI handling", () => {
  test("decodes a base64 data:application/json URI", async () => {
    const json = JSON.stringify({ name: "Foo", attributes: [{ trait_type: "A", value: "1" }] });
    const uri = `data:application/json;base64,${Buffer.from(json, "utf-8").toString("base64")}`;
    const result = await fetchJson(uri);
    expect(result).toEqual({ name: "Foo", attributes: [{ trait_type: "A", value: "1" }] });
  });

  test("decodes a RAW (non-base64) data:application/json URI with a comma in the payload", async () => {

    const uri = `data:application/json,${encodeURIComponent(
      JSON.stringify({ name: "Lifeform 1", attributes: [{ trait_type: "Kind", value: "Loop" }, { trait_type: "Age", value: 5 }] })
    )}`;

    const rawUri = `data:application/json,{"name":"Lifeform 1","attributes":[{"trait_type":"Kind","value":"Loop"},{"trait_type":"Age","value":5}]}`;
    const decodedPercent = await fetchJson(uri);
    const decodedRaw = await fetchJson(rawUri);
    const expected = { name: "Lifeform 1", attributes: [{ trait_type: "Kind", value: "Loop" }, { trait_type: "Age", value: 5 }] };
    expect(decodedPercent).toEqual(expected);
    expect(decodedRaw).toEqual(expected);
  });

  test("returns null for a malformed data URI", async () => {
    expect(await fetchJson("data:application/json,")).toBeNull();
  });
});
