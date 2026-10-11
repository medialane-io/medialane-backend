import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerBuildRoutes } from "./build.js";
import type { AppEnv } from "../../../types/hono.js";

const ME = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("account", { id: "app", status: "ACTIVE" } as never);
    await next();
  });
  registerBuildRoutes(a);
  return a;
}

const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("action intent routes", () => {
  test("an unsupported token is a 400 with the reason", async () => {
    const res = await app().request("/transfer-token", post({ owner: ME, token: "0x999", recipient: ME, amount: "1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That token is not supported" });
  });

  test("a malformed body is a 400", async () => {
    const res = await app().request("/comment", post({ author: ME, nftContract: ME, tokenId: "1", text: "" }));
    expect(res.status).toBe(400);
  });
});
