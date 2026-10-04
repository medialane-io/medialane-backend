import { Hono } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import { prismaRunStore } from "../../../launchpad/run-store.js";
import { createRunContext, type RunRouteDeps } from "./context.js";
import { createDraftRoutes } from "./drafts.js";
import { dataTokenizationSteps } from "./data-tokenization.js";
import { ipTicketingSteps } from "./ip-ticketing.js";
import { certificateEmissionSteps } from "./certificate-emission.js";
import { createRunStepRoutes } from "./steps.js";

export function createRunRoutes(deps: RunRouteDeps): Hono<AppEnv> {
  const ctx = createRunContext(deps);
  const steps = createRunStepRoutes(ctx, [
    dataTokenizationSteps(ctx),
    ipTicketingSteps(ctx),
    certificateEmissionSteps(ctx),
  ]);
  const app = new Hono<AppEnv>();
  app.route("/", createDraftRoutes(ctx));
  app.route("/:id", steps);
  app.route("/:id/certificate-emission", steps);
  return app;
}

export const launchpadRuns = createRunRoutes({ store: prismaRunStore });
