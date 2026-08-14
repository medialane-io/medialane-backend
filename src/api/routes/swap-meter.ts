

import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const swap = new Hono<AppEnv>();

swap.post("/quote/meter", (c) => c.json({ data: { billed: true } }));
swap.post("/build/meter", (c) => c.json({ data: { billed: true } }));

export default swap;
