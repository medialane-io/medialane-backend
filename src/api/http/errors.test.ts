import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types/hono.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { badRequest, notFound, renderError } from "./errors.js";

function appThrowing(error: unknown, seen?: { status?: number }) {
  const app = new Hono<AppEnv>();
  app.use("*", cors({ origin: "*" }));
  app.use("*", requestIdMiddleware);
  app.use("*", async (c, next) => {
    await next();
    if (seen) seen.status = c.res.status;
  });
  app.get("/", () => {
    throw error;
  });
  app.onError(renderError);
  return app;
}

describe("renderError", () => {
  test("a thrown notFound is a 404 with the plain error body", async () => {
    const res = await appThrowing(notFound("Intent")).request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Intent not found" });
  });

  test("extra fields are merged into the body", async () => {
    const res = await appThrowing(badRequest("Invalid body", { details: { a: 1 } })).request("/");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid body", details: { a: 1 } });
  });

  test("a bare HTTPException keeps its status and message", async () => {
    const res = await appThrowing(new HTTPException(400, { message: "x" })).request("/");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "x" });
  });

  test("any other error is a 500 without its message", async () => {
    const res = await appThrowing(new Error("secret detail")).request("/");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  test("a thrown error keeps the request id, CORS headers and the status later middleware sees", async () => {
    const seen: { status?: number } = {};
    const res = await appThrowing(notFound("Intent"), seen).request("/", { headers: { origin: "https://x.test" } });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(seen.status).toBe(404);
  });
});
