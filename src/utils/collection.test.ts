// Tests for the registry-routing helpers added in audit P0-2 + R3 prep.
// Pure-function tests against the SDK registry — no DB.
import { describe, expect, test } from "bun:test";
import { getServiceByMarketplaceAddress } from "./collection.js";
import { getCoordinates } from "@medialane/sdk";

const SN = getCoordinates("STARKNET");

describe("getServiceByMarketplaceAddress", () => {
  test("resolves 721 marketplace address → ERC721 service", () => {
    const svc = getServiceByMarketplaceAddress(SN.marketplace721!);
    expect(svc?.id).toBe("medialane-marketplace-erc721");
    expect(svc?.standard).toBe("ERC721");
  });

  test("resolves 1155 marketplace address → ERC1155 service", () => {
    const svc = getServiceByMarketplaceAddress(SN.marketplace1155!);
    expect(svc?.id).toBe("medialane-marketplace-erc1155");
    expect(svc?.standard).toBe("ERC1155");
  });

  test("normalizes input before lookup (short address)", () => {
    // strip leading zeros — the helper should still match
    const short = "0x" + SN.marketplace721!.slice(2).replace(/^0+/, "");
    expect(getServiceByMarketplaceAddress(short)?.id).toBe("medialane-marketplace-erc721");
  });

  test("returns undefined for non-marketplace addresses", () => {
    expect(getServiceByMarketplaceAddress("0x1234")).toBeUndefined();
  });

  test("returns undefined for null/undefined input", () => {
    expect(getServiceByMarketplaceAddress(null)).toBeUndefined();
    expect(getServiceByMarketplaceAddress(undefined)).toBeUndefined();
    expect(getServiceByMarketplaceAddress("")).toBeUndefined();
  });

  test("does NOT match factory addresses of non-marketplace services", () => {
    // The filter restricts to medialane-marketplace-* ids — a MIP factory
    // address must not resolve as a marketplace, otherwise event routing
    // would mistake factory events for marketplace events.
    const result = getServiceByMarketplaceAddress(
      "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2", // MIP v0.3.0
    );
    expect(result).toBeUndefined();
  });
});
