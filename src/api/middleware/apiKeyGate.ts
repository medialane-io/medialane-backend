import type { MiddlewareHandler, Context, Next } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { apiKeyRateLimit } from "./rateLimit.js";
import { meter } from "./meter.js";

function composeMiddleware(handlers: readonly MiddlewareHandler<AppEnv>[]): MiddlewareHandler<AppEnv> {
  return function chained(c: Context<AppEnv>, next: Next) {
    const run = (i: number): Promise<Response | void> => {
      if (i >= handlers.length) return Promise.resolve(next());

      return Promise.resolve(handlers[i](c, (() => run(i + 1)) as Next));
    };
    return run(0);
  };
}

export const apiKeyGate: MiddlewareHandler<AppEnv> = composeMiddleware([apiKeyAuth, apiKeyRateLimit(), meter()]);
