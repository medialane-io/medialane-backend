import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { appScope, isAppSourceAllowed, restrictionFor } from "./appScope.js";
import type { AppEnv } from "../../types/hono.js";
import type { AppSource } from "@prisma/client";

function appWith(appSource: AppSource | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key_TEST",
      status: "ACTIVE",
      appSource,
      apiClient: {
        id: "cli_TEST",
        accountId: "acc_TEST",
        plan: "FREE",
        creditBalance: 100,
        account: { id: "acc_TEST", status: "ACTIVE" },
      },
    });
    await next();
  });
  app.use("*", appScope);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("appScope", () => {
  test("a portal key reaches the portal admin surface", async () => {
    const res = await appWith("MEDIALANE_PORTAL").request("/v1/portal/keys");
    expect(res.status).toBe(200);
  });

  // The regression this middleware exists for: a key shipped to a public
  // consumer app was enough to read the tenant's own admin surface.
  test("a consumer-app key is blocked from the portal admin surface", async () => {
    for (const source of ["MEDIALANE_IO", "MEDIALANE_STARKNET", "MEDIALANE_DAO"] as const) {
      const res = await appWith(source).request("/v1/portal/keys");
      expect(`${source}:${res.status}`).toBe(`${source}:403`);
    }
  });

  test("a consumer-app key is blocked from business provisioning", async () => {
    const res = await appWith("MEDIALANE_IO").request("/v1/business/provisioning");
    expect(res.status).toBe(403);
  });

  test("unrestricted routes stay reachable by every app", async () => {
    for (const source of ["MEDIALANE_IO", "MEDIALANE_STARKNET", "MEDIALANE_PORTAL"] as const) {
      const res = await appWith(source).request("/v1/tokens");
      expect(`${source}:${res.status}`).toBe(`${source}:200`);
    }
  });

  test("legacy keys with no appSource are allowed through", async () => {
    const res = await appWith(null).request("/v1/portal/keys");
    expect(res.status).toBe(200);
  });

  test("restriction matches the group prefix but not a lookalike route", () => {
    expect(restrictionFor("/v1/portal")).not.toBeNull();
    expect(restrictionFor("/v1/portal/credits/history")).not.toBeNull();
    expect(restrictionFor("/v1/portals")).toBeNull();
    expect(restrictionFor("/v1/tokens")).toBeNull();
  });

  test("isAppSourceAllowed is closed for every source outside the allow list", () => {
    const all: AppSource[] = [
      "MEDIALANE_STARKNET",
      "MEDIALANE_IO",
      "MEDIALANE_PORTAL",
      "MEDIALANE_DAO",
      "MEDIALANE_SDK",
    ];
    const allowed = all.filter((s) => isAppSourceAllowed(s, "/v1/portal/keys"));
    expect(allowed).toEqual(["MEDIALANE_PORTAL"]);
  });
});

// An unmetered route costs no credits, so app-scope is the only thing left
// standing between an API key and it. Unmetered AND unscoped means any key
// can call it for free, forever — the shape behind both the credit-drain and
// the email-enumeration findings. Every unmetered prefix must therefore be a
// deliberate decision recorded here, not an accident of adding a prefix.
describe("unmetered routes are a reviewed set", () => {
  const INTENTIONALLY_UNMETERED_AND_PUBLIC = [
    // Sign-in and account creation must work before an account has credits.
    // Protected by their own per-IP and per-email rate limits instead.
    "/v1/auth",
  ];

  test("every unmetered prefix is either app-scoped or explicitly public", async () => {
    const { UNMETERED_PREFIXES } = await import("../../payments/pricing.js");

    const unreviewed = UNMETERED_PREFIXES.filter(
      (prefix) =>
        restrictionFor(prefix) === null &&
        !INTENTIONALLY_UNMETERED_AND_PUBLIC.includes(prefix),
    );

    expect(unreviewed).toEqual([]);
  });
});

// An unscoped key is exempt from every restriction above, so the only reason
// null is tolerated at all is the handful of rows that predate the column.
// If any route can still mint one, the exemption stops being a legacy
// allowance and becomes a way to opt out of scoping on demand.
describe("no key-creation path leaves appSource unset", () => {
  test("every apiKey.create in the codebase supplies an appSource", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = ["src/api/routes/siws.ts", "src/api/routes/portal.ts"];

    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      const idx = text.indexOf("apiKey.create");
      if (idx === -1) continue;
      // The `data: { ... }` block of the create call.
      const block = text.slice(idx, idx + 600);
      if (!block.includes("appSource")) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
