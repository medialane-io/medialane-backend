import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";

describe("self-service API keys", () => {
  test("an account can create another key however many it already has", async () => {
    mock.module("../../db/client.js", () => ({
      default: {
        account: {
          findUnique: mock(() =>
            Promise.resolve({
              id: "a1",
              status: "ACTIVE",
              apiClient: { id: "ac1", accountId: "a1", plan: "PREMIUM", creditBalance: 0 },
            }),
          ),
        },
        apiKey: {
          count: mock(() => Promise.resolve(50)),
          create: mock(({ data }: { data: { prefix: string; label?: string } }) =>
            Promise.resolve({ id: "k1", prefix: data.prefix, label: data.label ?? null }),
          ),
        },
      },
    }));
    const { default: portal } = await import("./portal.js");
    const { issueAccountSessionToken } = await import("../../utils/accountSessionToken.js");

    const app = new Hono<AppEnv>();
    app.route("/", portal);

    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issueAccountSessionToken("a1")}` },
      body: JSON.stringify({ label: "sixth" }),
    });
    expect(res.status).toBe(201);
  });
});
