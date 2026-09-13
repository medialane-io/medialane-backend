import { test, expect } from "bun:test";
import { TENANT_SLUG_INPUT, normalizeTenantSlug } from "./tenant.js";

test("a tenant is named by a slug, so a new partner is a row rather than a migration", () => {
  expect(typeof normalizeTenantSlug("acme_records")).toBe("string");
  expect(normalizeTenantSlug("acme_records")).toBe("ACME_RECORDS");
});

test("the name a caller sends is read the same however it is typed", () => {
  expect(normalizeTenantSlug(" medialane_io ")).toBe("MEDIALANE_IO");
});

test("the old dapp name still reaches the tenant it became", () => {
  expect(normalizeTenantSlug("MEDIALANE_DAPP")).toBe("MEDIALANE_STARKNET");
});

test("the slugs an app may send are the ones already in use", () => {
  expect(TENANT_SLUG_INPUT).toContain("MEDIALANE_IO");
  expect(TENANT_SLUG_INPUT).toContain("MEDIALANE_PORTAL");
});
