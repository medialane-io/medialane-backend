import type { MiddlewareHandler, Context, Next } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { apiKeyRateLimit } from "./rateLimit.js";
import { meter } from "./meter.js";

export function composeMiddleware(handlers: readonly MiddlewareHandler<AppEnv>[]): MiddlewareHandler<AppEnv> {
  return async function chained(c: Context<AppEnv>, next: Next) {
    const run = async (i: number): Promise<void> => {
      if (i >= handlers.length) {
        await next();
        return;
      }
      const res = await handlers[i](c, (() => run(i + 1)) as Next);
      if (res instanceof Response) c.res = res;
    };
    await run(0);
  };
}

export const apiKeyGate: MiddlewareHandler<AppEnv> = composeMiddleware([apiKeyAuth, apiKeyRateLimit(), meter()]);
