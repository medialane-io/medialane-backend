import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import swap from "./swap-meter.js";
import type { AppEnv } from "../../types/hono.js";

describe("POST /v1/swap/*", () => {
  for (const path of ["/quote/meter", "/build/meter"]) {
    test(`${path} returns billed:true`, async () => {
      const app = new Hono<AppEnv>();
      app.route("/", swap);
      const res = await app.request(path, { method: "POST" });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { billed: true } });
    });
  }
});
