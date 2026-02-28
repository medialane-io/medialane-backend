import type { ApiKey, Tenant } from "@prisma/client";

/**
 * Hono context variables set by apiKeyAuth middleware.
 */
export type AppVariables = {
  tenant: Tenant;
  apiKey: ApiKey & { tenant: Tenant };
};

/**
 * Full Hono Env type. Use as:
 *   new Hono<AppEnv>()
 *   MiddlewareHandler<AppEnv>
 */
export type AppEnv = { Variables: AppVariables };
