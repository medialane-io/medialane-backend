import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";
import { Hono } from "hono";
import { createApp, requestBodyLimit } from "./server.js";

const MB = 1024 * 1024;

function post(path: string, bytes: number, chunked = false) {
  const app = createApp();
  const payload = new Uint8Array(bytes);
  if (!chunked) return app.request(path, { method: "POST", body: payload });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  return app.request(path, { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("request body limits", () => {
  const limited = new Hono().post("/", requestBodyLimit, (c) => c.text("ok"));

  test("a body of the upload size passes the limit", async () => {
    expect((await limited.request("/", { method: "POST", body: new Uint8Array(MAX_UPLOAD_BYTES) })).status).toBe(200);
  });

  test("a body over the upload size is refused", async () => {
    expect((await limited.request("/", { method: "POST", body: new Uint8Array(MAX_UPLOAD_BYTES + 1) })).status).toBe(413);
  });

  test("a streamed body with no content-length is still refused", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1));
        controller.close();
      },
    });
    expect((await limited.request("/", { method: "POST", body, duplex: "half" } as RequestInit)).status).toBe(413);
  });

  test.each(["/v1/rpc", "/v1/portal/runs", "/v1/metadata/upload"])(
    "a request without an API key to %s is refused before its body is read",
    async (path) => {
      expect((await post(path, 5 * MB, true)).status).toBe(401);
    },
  );
});

describe("on-chain images", () => {
  test("an image request without an API key is refused", async () => {
    const res = await createApp().request(`/media/starknet/0x${"a".repeat(64)}/1/image`);
    expect(res.status).toBe(401);
  });
});
