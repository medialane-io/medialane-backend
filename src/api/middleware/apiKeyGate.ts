import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { appId } from "./appId.js";
import { meter } from "./meter.js";

export const apiKeyGate: MiddlewareHandler<AppEnv>[] = [apiKeyAuth, appId, meter()];
