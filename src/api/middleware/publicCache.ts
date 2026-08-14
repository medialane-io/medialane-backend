import type { MiddlewareHandler } from "hono";

export function publicCache(seconds: number): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.status === 200) {
      c.res.headers.set("Cache-Control", `public, max-age=${seconds}`);
    }
  };
}
