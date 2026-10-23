import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import { renderError } from "./errors.js";
import { validated } from "./validate.js";

const schema = z.object({ name: z.string().optional(), count: z.number().int().default(1) });

function app() {
  const a = new Hono<AppEnv>();
  a.post("/", validated("json", schema), (c) => c.json({ body: c.req.valid("json") }));
  a.post("/custom", validated("json", z.object({ userAddress: z.string() }), { message: "userAddress is required" }), (c) => c.json(c.req.valid("json")));
  a.get("/q", validated("query", z.object({ n: z.coerce.number().int() })), (c) => c.json(c.req.valid("query")));
  a.onError(renderError);
  return a;
}

const json = { "content-type": "application/json" };

describe("validated json", () => {
  test("a valid body passes through typed, with defaults applied", async () => {
    const res = await app().request("/", { method: "POST", body: '{"name":"a"}', headers: json });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { name: "a", count: 1 } });
  });

  test("an invalid body is a 400 with the flattened issues", async () => {
    const res = await app().request("/", { method: "POST", body: '{"count":"x"}', headers: json });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe("Invalid body");
    expect(body.details.fieldErrors.count?.length).toBeGreaterThan(0);
  });

  test("no content-type and no body is an empty object, so an all-optional schema passes", async () => {
    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { count: 1 } });
  });

  test("an empty body with a JSON content-type is malformed", async () => {
    const res = await app().request("/", { method: "POST", headers: json });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Malformed JSON in request body" });
  });

  test("malformed JSON is a 400", async () => {
    const res = await app().request("/", { method: "POST", body: "{x", headers: json });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Malformed JSON in request body" });
  });

  test.each([["[]"], ["null"]])("%s against an object schema is an invalid body", async (raw) => {
    const res = await app().request("/", { method: "POST", body: raw, headers: json });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid body");
  });
});

describe("validated json with its own message", () => {
  test("a failing body answers with exactly that message and no details", async () => {
    const res = await app().request("/custom", { method: "POST", body: "{}", headers: json });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "userAddress is required" });
  });

  test("an empty request answers with the same message", async () => {
    const res = await app().request("/custom", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "userAddress is required" });
  });
});

describe("validated query", () => {
  test("a failing query is a 400 Invalid query", async () => {
    const res = await app().request("/q?n=abc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid query");
  });

  test("a passing query is typed", async () => {
    expect(await (await app().request("/q?n=3")).json()).toEqual({ n: 3 });
  });
});
