

import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { registerBuildRoutes } from "./build.js";
import { registerLifecycleRoutes } from "./lifecycle.js";

const intents = new Hono<AppEnv>();

registerBuildRoutes(intents);
registerLifecycleRoutes(intents);

export default intents;
