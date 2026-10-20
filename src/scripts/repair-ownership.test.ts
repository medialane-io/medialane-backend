import { describe, expect, test } from "bun:test";
import { ownershipDifferences } from "./repair-ownership.js";

const C = "0xc";
const row = (tokenId: string, owner: string, amount = "1") => ({ contractAddress: C, tokenId, owner, amount });
const erc721 = (tokenId: string, owner: string | null) =>
  ({ standard: "ERC721" as const, contractAddress: C, tokenId, owner });
const erc1155 = (tokenId: string, owner: string, amount: bigint) =>
  ({ standard: "ERC1155" as const, contractAddress: C, tokenId, owner, amount });

describe("stored ownership compared with the chain", () => {
  test("matching rows report no differences", () => {
    expect(ownershipDifferences([row("1", "0xa"), row("2", "0xb", "3")], [erc721("1", "0xa"), erc1155("2", "0xb", 3n)]))
      .toMatchObject({ changed: 0, removed: 0, added: 0 });
  });

  test("a different erc721 owner counts as changed", () => {
    expect(ownershipDifferences([row("1", "0xa")], [erc721("1", "0xb")])).toMatchObject({ changed: 1, removed: 0, added: 0 });
  });

  test("an erc721 row for a token with no owner counts as removed", () => {
    expect(ownershipDifferences([row("1", "0xa")], [erc721("1", null)])).toMatchObject({ changed: 0, removed: 1, added: 0 });
  });

  test("an erc721 owner with no row counts as added", () => {
    expect(ownershipDifferences([], [erc721("1", "0xa")])).toMatchObject({ changed: 0, removed: 0, added: 1 });
  });

  test("an erc1155 amount that differs counts as changed", () => {
    expect(ownershipDifferences([row("2", "0xb", "3")], [erc1155("2", "0xb", 1n)])).toMatchObject({ changed: 1, removed: 0, added: 0 });
  });

  test("only the facts that differ from the stored rows are returned to write", () => {
    const result = ownershipDifferences([row("1", "0xa"), row("2", "0xa")], [erc721("1", "0xa"), erc721("2", "0xb")]);
    expect(result.stale).toEqual([erc721("2", "0xb")]);
  });
});
