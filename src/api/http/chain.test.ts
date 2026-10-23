import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { chainFilterScope, chainScope } from "./chain.js";
import { renderError } from "./errors.js";

function single(enabled?: readonly ("STARKNET" | "BASE")[]) {
  const app = new Hono<AppEnv>();
  app.get("/", chainScope(enabled), (c) => c.json({ chain: c.get("chain") }));
  app.onError(renderError);
  return app;
}

function filtered(enabled?: readonly ("STARKNET" | "BASE")[]) {
  const app = new Hono<AppEnv>();
  app.get("/", chainFilterScope(enabled), (c) => c.json({ chainFilter: c.get("chainFilter") }));
  app.onError(renderError);
  return app;
}

describe("chainScope", () => {
  test("no chain gives the default chain", async () => {
    expect(await (await single().request("/")).json()).toEqual({ chain: "STARKNET" });
  });

  test("empty chain gives the default chain", async () => {
    expect(await (await single().request("/?chain=")).json()).toEqual({ chain: "STARKNET" });
  });

  test("the chain is case-insensitive", async () => {
    expect(await (await single().request("/?chain=starknet")).json()).toEqual({ chain: "STARKNET" });
  });

  test("a chain that is not enabled is refused", async () => {
    const res = await single().request("/?chain=base");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid chain" });
  });

  test("an unknown chain is refused", async () => {
    expect((await single().request("/?chain=bogus")).status).toBe(400);
  });

  test("all is refused where one chain is required", async () => {
    const res = await single().request("/?chain=all");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid chain" });
  });

  test("a chain added to the enabled list is accepted", async () => {
    expect(await (await single(["STARKNET", "BASE"]).request("/?chain=base")).json()).toEqual({ chain: "BASE" });
  });
});

describe("chainFilterScope", () => {
  test("no chain gives the default chain", async () => {
    expect(await (await filtered().request("/")).json()).toEqual({ chainFilter: { chain: "STARKNET" } });
  });

  test("all passes through", async () => {
    expect(await (await filtered().request("/?chain=all")).json()).toEqual({ chainFilter: "all" });
  });

  test("a chain that is not enabled is refused", async () => {
    const res = await filtered().request("/?chain=bogus");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid chain" });
  });
});
