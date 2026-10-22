import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";
import { createApp } from "./server.js";

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
  test("a body over 1 MB is refused on a normal route", async () => {
    expect((await post("/v1/rpc", 2 * MB)).status).toBe(413);
  });

  test("a streamed body with no content-length is still refused", async () => {
    expect((await post("/v1/rpc", 2 * MB, true)).status).toBe(413);
  });

  test("a small body reaches the API key check", async () => {
    expect((await post("/v1/rpc", 1024)).status).toBe(401);
  });

  test.each(["/v1/metadata/upload", "/v1/metadata/upload-file", "/v1/metadata/upload-directory"])(
    "%s accepts the upload size and refuses one byte more",
    async (path) => {
      expect((await post(path, MAX_UPLOAD_BYTES)).status).toBe(401);
      expect((await post(path, MAX_UPLOAD_BYTES + 1)).status).toBe(413);
    },
  );
});

describe("on-chain images", () => {
  test("an image request without an API key is refused", async () => {
    const res = await createApp().request(`/media/starknet/0x${"a".repeat(64)}/1/image`);
    expect(res.status).toBe(401);
  });
});
