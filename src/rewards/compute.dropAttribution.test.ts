import { test, expect } from "bun:test";
import {
  dropClaimTransferFilter,
  soldOutClaimFilter,
  dedupeLaunchContracts,
  dropCollectionFilter,
} from "./compute.js";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

test("drop claims are selected as mints from the zero address", () => {
  const filter = dropClaimTransferFilter(["0xdrop1", "0xdrop2"]);
  expect(filter.fromAddress).toBe(ZERO);
  expect(filter.contractAddress).toEqual({ in: ["0xdrop1", "0xdrop2"] });
});

test("drop claims are never selected as transfers away from the zero address", () => {
  const filter = dropClaimTransferFilter(["0xdrop1"]);
  expect(filter.fromAddress).not.toEqual({ not: ZERO });
});

test("sold-out counting also counts mints from the zero address", () => {
  const filter = soldOutClaimFilter("0xdrop1");
  expect(filter.fromAddress).toBe(ZERO);
  expect(filter.contractAddress).toBe("0xdrop1");
});

test("a contract appearing in both launch sources is awarded once", () => {
  const early = new Date("2026-01-01T00:00:00Z");
  const late = new Date("2026-02-01T00:00:00Z");
  const out = dedupeLaunchContracts([
    { contract: "0xdrop1", createdAt: early },
    { contract: "0xdrop1", createdAt: late },
    { contract: "0xpop1", createdAt: late },
  ]);
  expect(out.length).toBe(2);
  expect(out.map((e) => e.contract).sort()).toEqual(["0xdrop1", "0xpop1"]);
});

test("deduping keeps the earliest launch date for a contract", () => {
  const early = new Date("2026-01-01T00:00:00Z");
  const late = new Date("2026-02-01T00:00:00Z");
  const out = dedupeLaunchContracts([
    { contract: "0xdrop1", createdAt: late },
    { contract: "0xdrop1", createdAt: early },
  ]);
  expect(out[0].createdAt.toISOString()).toBe(early.toISOString());
});

test("drops are enumerated by service, not by the off-chain conditions table", () => {
  const filter = dropCollectionFilter();
  expect(filter.service).toBe("drop-collection");
  expect(filter.deletedAt).toBe(null);
});
