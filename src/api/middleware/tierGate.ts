import type { MiddlewareHandler } from "hono";
import type { Plan } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";

const PLAN_RANK: Record<Plan, number> = {
  FREE: 0,
  PREMIUM: 1,
};

export function requirePlan(minPlan: Plan): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const apiClient = c.get("apiClient");

    if (!apiClient) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if ((PLAN_RANK[apiClient.plan] ?? 0) < PLAN_RANK[minPlan]) {
      return c.json(
        { error: "Upgrade required", requiredPlan: minPlan },
        403
      );
    }

    await next();
  };
}
