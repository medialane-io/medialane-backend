// /v1/intents — registrar pattern, same as routes/admin/.
// Each domain file (build/lifecycle) exports a registerXxxRoutes function
// that mutates the same Hono instance. Internal helpers (settle.ts) are
// imported directly by lifecycle.ts; no route registration needed.
import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { registerBuildRoutes } from "./build.js";
import { registerLifecycleRoutes } from "./lifecycle.js";

const intents = new Hono<AppEnv>();

registerBuildRoutes(intents);
registerLifecycleRoutes(intents);

export default intents;
