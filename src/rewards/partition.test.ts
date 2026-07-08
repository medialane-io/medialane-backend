import { describe, expect, test } from "bun:test";
import { mintActionForService, creationActionForService } from "./partition.js";

describe("mintActionForService", () => {
  test("issuance services score mint_asset", () => {
    expect(mintActionForService("mip-erc721")).toBe("mint_asset");
    expect(mintActionForService("mip-erc1155")).toBe("mint_asset");
    expect(mintActionForService("ip-erc721")).toBe("mint_asset");
  });
  test("non-issuance services score nothing", () => {
    expect(mintActionForService("ip-tickets")).toBeNull();
    expect(mintActionForService("ip-club")).toBeNull();
  });
  test("pop/drop/external/unknown mints score nothing here", () => {
    expect(mintActionForService("pop-protocol")).toBeNull(); // claim_pop owns it
    expect(mintActionForService("drop-collection")).toBeNull(); // claim_drop owns it
    expect(mintActionForService("external-erc721")).toBeNull();
    expect(mintActionForService(undefined)).toBeNull();
  });
});

describe("creationActionForService", () => {
  test("issuance collections score create_collection", () => {
    expect(creationActionForService("mip-erc721")).toBe("create_collection");
  });
  test("drop/pop creations score nothing here (launch_launchpad owns them)", () => {
    expect(creationActionForService("drop-collection")).toBeNull();
    expect(creationActionForService("pop-protocol")).toBeNull();
  });
  test("non-issuance creations score nothing", () => {
    expect(creationActionForService("ip-tickets")).toBeNull();
    expect(creationActionForService("ip-club")).toBeNull();
  });
  test("external collections score nothing", () => {
    expect(creationActionForService("external-erc721")).toBeNull();
  });
});
