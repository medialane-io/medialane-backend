import { describe, expect, test } from "bun:test";
import { ipfsGatewayUrls } from "./resolver.js";

const PUBLIC = ["https://gateway.pinata.cloud/ipfs", "https://ipfs.filebase.io/ipfs"];

describe("ipfsGatewayUrls", () => {
  test("the configured dedicated gateway comes first, then the public ones", () => {
    expect(ipfsGatewayUrls("example.mypinata.cloud")).toEqual(["https://example.mypinata.cloud/ipfs", ...PUBLIC]);
  });

  test("a configured URL with scheme and trailing slash is accepted", () => {
    expect(ipfsGatewayUrls("https://example.mypinata.cloud/")[0]).toBe("https://example.mypinata.cloud/ipfs");
  });

  test("the default public gateway is not listed twice", () => {
    expect(ipfsGatewayUrls("gateway.pinata.cloud")).toEqual(PUBLIC);
  });
});
