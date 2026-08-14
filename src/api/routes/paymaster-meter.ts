

import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

const paymaster = new Hono<AppEnv>();

paymaster.post("/invoke/build", (c) => c.json({ data: { billed: true } }));
paymaster.post("/invoke/execute", (c) => c.json({ data: { billed: true } }));
paymaster.post("/deploy/build", (c) => c.json({ data: { billed: true } }));
paymaster.post("/deploy/execute", (c) => c.json({ data: { billed: true } }));

export default paymaster;
