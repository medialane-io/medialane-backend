import { describe, it, expect } from "bun:test";
import { defaultExternalService } from "./externalService.js";

describe("defaultExternalService", () => {
  it("maps ERC721 to external-erc721", () => {
    expect(defaultExternalService("ERC721")).toBe("external-erc721");
  });
  it("maps ERC1155 to external-erc1155", () => {
    expect(defaultExternalService("ERC1155")).toBe("external-erc1155");
  });
  it("maps ERC20 to external-erc20", () => {
    expect(defaultExternalService("ERC20")).toBe("external-erc20");
  });
});
