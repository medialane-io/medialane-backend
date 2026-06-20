import type { MiddlewareHandler } from "hono";
import type { TenantPlan } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";

const PLAN_RANK: Record<TenantPlan, number> = {
  FREE: 0,
  PREMIUM: 1,
};

/**
 * Returns middleware that rejects requests from tenants below `minPlan`.
 * Must be placed after apiKeyAuth.
 */
export function requirePlan(minPlan: TenantPlan): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenant = c.get("tenant");

    if (!tenant) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if ((PLAN_RANK[tenant.plan] ?? 0) < PLAN_RANK[minPlan]) {
      return c.json(
        { error: "Upgrade required", requiredPlan: minPlan },
        403
      );
    }

    await next();
  };
}
