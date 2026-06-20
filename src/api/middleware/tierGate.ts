import type { MiddlewareHandler } from "hono";
import type { Plan } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";

const PLAN_RANK: Record<Plan, number> = {
  FREE: 0,
  PREMIUM: 1,
};

/**
 * Returns middleware that rejects requests from accounts below `minPlan`.
 * Plan is Account state (07-identity §III). Must be placed after apiKeyAuth.
 */
export function requirePlan(minPlan: Plan): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const account = c.get("account");

    if (!account) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if ((PLAN_RANK[account.plan] ?? 0) < PLAN_RANK[minPlan]) {
      return c.json(
        { error: "Upgrade required", requiredPlan: minPlan },
        403
      );
    }

    await next();
  };
}
