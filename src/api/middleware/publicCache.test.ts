import { test, expect } from "bun:test";
import { Hono } from "hono";
import { publicCache } from "./publicCache.js";

function app() {
  const a = new Hono();
  a.get("/list", publicCache(30), (c) => c.json({ data: [] }));
  a.get("/missing", publicCache(30), (c) => c.json({ error: "not found" }, 404));
  a.post("/list", publicCache(30), (c) => c.json({ data: { ok: true } }));
  return a;
}

test("successful GET gets public max-age", async () => {
  const res = await app().request("/list");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=30");
});

test("non-200 GET is not cached", async () => {
  const res = await app().request("/missing");
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBeNull();
});

test("non-GET is not cached even on 200", async () => {
  const res = await app().request("/list", { method: "POST" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBeNull();
});
