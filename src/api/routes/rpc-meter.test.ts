import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import rpc from "./rpc-meter.js";
import type { AppEnv } from "../../types/hono.js";

describe("POST /meter", () => {
  test("echoes the billed method back", async () => {
    const app = new Hono<AppEnv>();
    app.route("/", rpc);
    const res = await app.request("/meter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "starknet_addInvokeTransaction" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: { billed: true, method: "starknet_addInvokeTransaction" } });
  });

  test("defaults method to 'unknown' when missing", async () => {
    const app = new Hono<AppEnv>();
    app.route("/", rpc);
    const res = await app.request("/meter", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.method).toBe("unknown");
  });
});
