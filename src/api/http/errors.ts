import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../../types/hono.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("http");

export function httpError(
  status: ContentfulStatusCode,
  message: string,
  extra?: Record<string, unknown>,
): HTTPException {
  return new HTTPException(status, {
    message,
    res: Response.json({ error: message, ...extra }, { status }),
  });
}

export const notFound = (what: string) => httpError(404, `${what} not found`);

export const forbidden = (message: string) => httpError(403, message);

export const badRequest = (message: string, extra?: Record<string, unknown>) => httpError(400, message, extra);

export const renderError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    return err.res ?? c.json({ error: err.message }, err.status);
  }
  log.error({ err, requestId: c.get("requestId") }, "Unhandled request error");
  return c.json({ error: "Internal server error" }, 500);
};
