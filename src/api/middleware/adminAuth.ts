import type { MiddlewareHandler } from "hono";
import { ADMIN_HEADERS } from "@medialane/sdk/starknet";
import type { AppEnv } from "../../types/hono.js";
import { adminOrPortalAccountAuth } from "./adminSecretAuth.js";
import { adminSignatureAuth } from "./adminSignatureAuth.js";

/**
 * Accepts EITHER signed-request auth (browsers/agents, when x-ml-admin-* headers
 * are present) OR the existing master-key / portal-service-secret path (CLI,
 * scripts, /admin/accounts/*). Additive — server-to-server callers are unchanged.
 */
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header(ADMIN_HEADERS.grant)) return adminSignatureAuth(c, next);
  return adminOrPortalAccountAuth(c, next);
};
