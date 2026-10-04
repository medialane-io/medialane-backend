import { describe, expect, test } from "bun:test";
import { FIRST_PARTY_APPS, appByName } from "./registry.js";
import { IO_VERIFICATION_DAYS } from "../utils/accountLifecycle.js";

describe("first-party app registry", () => {
  test("every app has a unique name and a display name", () => {
    const names = FIRST_PARTY_APPS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const app of FIRST_PARTY_APPS) {
      expect(app.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(app.displayName.length).toBeGreaterThan(0);
    }
  });

  test("display names are unique, because the one-time client link matches on them", () => {
    const names = FIRST_PARTY_APPS.map((a) => a.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("lists the apps that already send an app name", () => {
    expect(FIRST_PARTY_APPS.map((a) => a.name).sort()).toEqual([
      "MEDIALANE_DAO",
      "MEDIALANE_IO",
      "MEDIALANE_PORTAL",
      "MEDIALANE_STARKNET",
    ]);
  });

  test("only io has an email confirmation window, and it is the existing 7 days", () => {
    expect(appByName("MEDIALANE_IO")?.emailConfirmDays).toBe(IO_VERIFICATION_DAYS);
    for (const app of FIRST_PARTY_APPS.filter((a) => a.name !== "MEDIALANE_IO")) {
      expect(app.emailConfirmDays).toBeNull();
    }
  });

  test("appByName returns undefined for an unregistered name", () => {
    expect(appByName("NOT_AN_APP")).toBeUndefined();
  });
});
