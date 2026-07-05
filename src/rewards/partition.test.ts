import { describe, expect, test } from "bun:test";
import { mintActionForService, creationActionForService } from "./partition.js";

describe("mintActionForService", () => {
  test("issuance services score mint_asset", () => {
    expect(mintActionForService("mip-erc721")).toBe("mint_asset");
    expect(mintActionForService("mip-erc1155")).toBe("mint_asset");
    expect(mintActionForService("ip-erc721")).toBe("mint_asset");
  });
  test("tickets and clubs claim their own actions", () => {
    expect(mintActionForService("ip-tickets")).toBe("buy_ticket");
    expect(mintActionForService("ip-club")).toBe("join_club");
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
  test("tickets/club creations get their own actions", () => {
    expect(creationActionForService("ip-tickets")).toBe("create_ticket_collection");
    expect(creationActionForService("ip-club")).toBe("create_club");
  });
  test("external collections score nothing", () => {
    expect(creationActionForService("external-erc721")).toBeNull();
  });
});
