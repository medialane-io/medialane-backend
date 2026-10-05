import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { createAppSourceCheck } from "./appSource.js";

function appWith(opts: { derived: string | null; clientId?: string | null }) {
  const appFor = mock(async (_clientId: string) => opts.derived);
  const warn = mock((_data: Record<string, unknown>, _message: string) => undefined);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (opts.clientId !== null) {
      c.set("apiKey", { id: "k1", status: "ACTIVE" as const, apiCredits: { id: opts.clientId ?? "client-1" } } as never);
    }
    return next();
  });
  app.use("*", createAppSourceCheck({ appFor, warn }));
  app.get("/ok", (c) => c.json({ ok: true }));
  return { app, appFor, warn };
}

describe("x-app-source in shadow mode", () => {
  test("without the header nothing is looked up or logged", async () => {
    const { app, appFor, warn } = appWith({ derived: "MEDIALANE_IO" });
    expect((await app.request("/ok")).status).toBe(200);
    expect(appFor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a header that matches the key's app is not logged", async () => {
    const { app, warn } = appWith({ derived: "MEDIALANE_IO" });
    expect((await app.request("/ok", { headers: { "x-app-source": "MEDIALANE_IO" } })).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a header that differs from the key's app is logged, and the request still goes through", async () => {
    const { app, warn } = appWith({ derived: "MEDIALANE_PORTAL" });
    const res = await app.request("/ok", { headers: { "x-app-source": "MEDIALANE_IO" } });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ declared: "MEDIALANE_IO", keyApp: "MEDIALANE_PORTAL", clientId: "client-1" });
  });

  test("a header from a key whose client has no app is logged with a null key app", async () => {
    const { app, warn } = appWith({ derived: null });
    await app.request("/ok", { headers: { "x-app-source": "MEDIALANE_IO" } });
    expect(warn.mock.calls[0]![0]).toMatchObject({ declared: "MEDIALANE_IO", keyApp: null });
  });

  test("a request with no key client passes through untouched", async () => {
    const { app, appFor, warn } = appWith({ derived: null, clientId: null });
    expect((await app.request("/ok", { headers: { "x-app-source": "MEDIALANE_IO" } })).status).toBe(200);
    expect(appFor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a failed lookup never fails the request", async () => {
    const warn = mock((_data: Record<string, unknown>, _message: string) => undefined);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiKey", { id: "k1", status: "ACTIVE" as const, apiCredits: { id: "client-1" } } as never);
      return next();
    });
    app.use("*", createAppSourceCheck({ appFor: async () => { throw new Error("db down"); }, warn }));
    app.get("/ok", (c) => c.json({ ok: true }));
    const res = await app.request("/ok", { headers: { "x-app-source": "MEDIALANE_IO" } });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe("could not check x-app-source");
  });
});
