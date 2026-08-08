// Credits every RPC call an app makes on a user's behalf. Each app's own
// /api/rpc proxy (io, dapp) keeps calling Alchemy directly with its own key —
// this route doesn't carry that traffic — but it must debit a credit for
// that call before forwarding it, same as every other billed action on this
// API. If this call 402s, the app's proxy must refuse to forward to Alchemy.
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const rpc = new Hono<AppEnv>();

rpc.post("/meter", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const method = typeof body?.method === "string" ? body.method : "unknown";
  return c.json({ data: { billed: true, method } });
});

export default rpc;
