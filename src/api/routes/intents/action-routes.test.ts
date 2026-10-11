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

  test("a POP proof that isn't felts is a 400", async () => {
    const res = await app().request("/pop-claim", post({ claimer: ME, collection: ME, proof: ["not-a-felt"] }));
    expect(res.status).toBe(400);
  });

  test("an empty allowlist is a 400", async () => {
    const res = await app().request("/drop-allowlist", post({ owner: ME, collection: ME, addresses: [] }));
    expect(res.status).toBe(400);
  });

  test("an unknown wallet action is a 400", async () => {
    const res = await app().request("/wallet-manage", post({ owner: ME, action: "drain" }));
    expect(res.status).toBe(400);
  });

  test("a swap with both or neither amount is a 400 with the reason", async () => {
    const res = await app().request("/swap", post({ taker: ME, sellTokenAddress: ME, buyTokenAddress: ME }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unsupported currency, or exactly one of sellAmountRaw/buyAmountRaw must be given" });
  });

  test("a funding transfer in an unaccepted token is a 400", async () => {
    const res = await app().request("/funding-transfer", post({ owner: ME, asset: "0x999", amountAtomic: "1" }));
    expect(res.status).toBe(400);
  });

  test("an unknown drop management action is a 400", async () => {
    const res = await app().request("/drop-manage", post({ owner: ME, collection: ME, action: "selfdestruct" }));
    expect(res.status).toBe(400);
  });

  test("POP issue without a recipient is a 400 with the reason", async () => {
    const res = await app().request("/pop-manage", post({ owner: ME, collection: ME, action: "issue" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "recipient is required" });
  });
});
