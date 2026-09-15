import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { prismaRunStore } from "../../../launchpad/run-store.js";
import { createRunContext, type RunRouteDeps } from "./context.js";
import { createDraftRoutes } from "./drafts.js";
import { createDataTokenizationRoutes } from "./data-tokenization.js";

export function createRunRoutes(deps: RunRouteDeps): Hono<AppEnv> {
  const ctx = createRunContext(deps);
  const app = new Hono<AppEnv>();
  app.route("/", createDraftRoutes(ctx));
  app.route("/", createDataTokenizationRoutes(ctx));
  return app;
}

export const launchpadRuns = createRunRoutes({ store: prismaRunStore });
