import { describe, expect, test } from "bun:test";
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

  test("upload-file accepts up to 11 MB and refuses more", async () => {
    expect((await post("/v1/metadata/upload-file", 2 * MB)).status).toBe(401);
    expect((await post("/v1/metadata/upload-file", 12 * MB)).status).toBe(413);
  });

  test("metadata json upload is capped at 512 KB", async () => {
    expect((await post("/v1/metadata/upload", 600 * 1024)).status).toBe(413);
  });
});
