// Credits every AVNU-swap call medialane-io's server makes on a user's
// behalf as part of the frictionless auto-swap-to-purchase flow. io's own
// /api/wallet/swap/{quote,build} routes call AVNU directly (no key needed
// for these two endpoints) — this route doesn't carry that traffic, but
// each of those two io routes must debit a credit here before forwarding
// to AVNU. If a call here 402s, the io route must refuse to forward.
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const swap = new Hono<AppEnv>();

swap.post("/quote/meter", (c) => c.json({ data: { billed: true } }));
swap.post("/build/meter", (c) => c.json({ data: { billed: true } }));

export default swap;
