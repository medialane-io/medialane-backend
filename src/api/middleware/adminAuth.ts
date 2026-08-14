import type { MiddlewareHandler } from "hono";
import { ADMIN_HEADERS } from "@medialane/sdk/starknet";
import type { AppEnv } from "../../types/hono.js";
import { adminOrPortalAccountAuth } from "./adminSecretAuth.js";
import { adminSignatureAuth } from "./adminSignatureAuth.js";

export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header(ADMIN_HEADERS.grant)) return adminSignatureAuth(c, next);
  return adminOrPortalAccountAuth(c, next);
};
