

import { describe, expect, test } from "bun:test";
import { getServiceByMarketplaceAddress } from "./collection.js";
import { STARKNET_MARKETPLACE_721_CONTRACT, STARKNET_MARKETPLACE_1155_CONTRACT } from "@medialane/sdk";

describe("getServiceByMarketplaceAddress", () => {
  test("resolves 721 marketplace address → ERC721 service", () => {
    const svc = getServiceByMarketplaceAddress(STARKNET_MARKETPLACE_721_CONTRACT);
    expect(svc?.id).toBe("medialane-marketplace-erc721");
    expect(svc?.standard).toBe("ERC721");
  });

  test("resolves 1155 marketplace address → ERC1155 service", () => {
    const svc = getServiceByMarketplaceAddress(STARKNET_MARKETPLACE_1155_CONTRACT);
    expect(svc?.id).toBe("medialane-marketplace-erc1155");
    expect(svc?.standard).toBe("ERC1155");
  });

  test("normalizes input before lookup (short address)", () => {

    const short = "0x" + STARKNET_MARKETPLACE_721_CONTRACT.slice(2).replace(/^0+/, "");
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

    const result = getServiceByMarketplaceAddress(
      "0x0322cb7119955e01ac778d40976eb3ba50540bb0899f812d612f9c7e63e49fd2",
    );
    expect(result).toBeUndefined();
  });
});
