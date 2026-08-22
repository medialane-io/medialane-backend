import { test, expect } from "bun:test";
import { getServicesByCapability } from "@medialane/sdk";
import {
  isIssuanceService,
  mintActionForService,
  creationActionForService,
  NON_ISSUANCE_MINT_SERVICES,
} from "./partition.js";

test("the three issuance services earn mint and creation XP", () => {
  for (const id of ["mip-erc721", "mip-erc1155", "ip-erc721"]) {
    expect(isIssuanceService(id)).toBe(true);
    expect(mintActionForService(id)).toBe("mint_asset");
    expect(creationActionForService(id)).toBe("create_collection");
  }
});

test("mint-capable services that are not issuance are excluded on purpose", () => {
  for (const id of ["ip-tickets", "ip-club", "pop-protocol"]) {
    expect(NON_ISSUANCE_MINT_SERVICES.has(id)).toBe(true);
    expect(isIssuanceService(id)).toBe(false);
    expect(mintActionForService(id)).toBe(null);
  }
});

test("every mint-capable service in the registry is classified either way", () => {
  const unclassified = getServicesByCapability("mint")
    .map((s) => s.id)
    .filter((id) => !isIssuanceService(id) && !NON_ISSUANCE_MINT_SERVICES.has(id));
  expect(unclassified).toEqual([]);
});

test("a null or unknown service earns nothing", () => {
  expect(mintActionForService(null)).toBe(null);
  expect(mintActionForService("not-a-service")).toBe(null);
  expect(creationActionForService(undefined)).toBe(null);
});
