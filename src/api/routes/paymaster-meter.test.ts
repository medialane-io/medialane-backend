import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import paymaster from "./paymaster-meter.js";
import type { AppEnv } from "../../types/hono.js";

describe("POST /v1/paymaster/*", () => {
  for (const path of ["/invoke/build", "/invoke/execute", "/deploy/build", "/deploy/execute"]) {
    test(`${path} returns billed:true`, async () => {
      const app = new Hono<AppEnv>();
      app.route("/", paymaster);
      const res = await app.request(path, { method: "POST" });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { billed: true } });
    });
  }
});
