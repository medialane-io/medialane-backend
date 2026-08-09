// Credits every AVNU-paymaster-sponsored call medialane-io makes on a
// user's behalf. io's own /api/wallet/{sponsored-invoke,deploy-sponsored}
// routes keep calling AVNU directly with their own API key — this route
// doesn't carry that traffic — but each of those four routes must debit a
// credit here (build AND execute, independently — an attacker can hit
// execute directly without ever calling build) before forwarding to AVNU.
// If a call here 402s, the io route must refuse to forward to AVNU.
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const paymaster = new Hono<AppEnv>();

paymaster.post("/invoke/build", (c) => c.json({ data: { billed: true } }));
paymaster.post("/invoke/execute", (c) => c.json({ data: { billed: true } }));
paymaster.post("/deploy/build", (c) => c.json({ data: { billed: true } }));
paymaster.post("/deploy/execute", (c) => c.json({ data: { billed: true } }));

export default paymaster;
