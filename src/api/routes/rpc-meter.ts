

import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const rpc = new Hono<AppEnv>();

rpc.post("/meter", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const method = typeof body?.method === "string" ? body.method : "unknown";
  return c.json({ data: { billed: true, method } });
});

export default rpc;
