import { Hono } from "hono";
import { PinataSDK } from "pinata";
import { env } from "../../config/env.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";

const log = createLogger("routes:metadata");
const metadata = new Hono();

const MAX_JSON_BYTES = 512 * 1024;    // 512 KB for metadata JSON
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB for media files

// Singleton — SDK holds no per-request state
const pinata = new PinataSDK({
  pinataJwt: env.PINATA_JWT,
  pinataGateway: env.PINATA_GATEWAY,
});

// GET /v1/metadata/signed-url
metadata.get("/signed-url", async (c) => {
  try {
    const url = await pinata.upload.public.createSignedURL({ expires: 30 });
    return c.json({ data: { url } });
  } catch (err: unknown) {
    log.error({ err }, "Failed to create signed URL");
    const msg = toErrorMessage(err);
    const status = msg.includes("403") || msg.includes("plan limits") ? 403 : 500;
    return c.json({ error: msg }, status);
  }
});

// POST /v1/metadata/upload — Upload metadata JSON
metadata.post("/upload", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ error: "Payload too large (max 512 KB)" }, 413);
  }
  try {
    const raw = await c.req.text();
    if (raw.length > MAX_JSON_BYTES) {
      return c.json({ error: "Payload too large (max 512 KB)" }, 413);
    }
    const body = JSON.parse(raw);
    const result = await pinata.upload.public.json(body);
    return c.json({ data: { cid: result.cid, url: `ipfs://${result.cid}` } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to upload metadata");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// POST /v1/metadata/upload-file — Upload media file
metadata.post("/upload-file", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_FILE_BYTES) {
    return c.json({ error: "Payload too large (max 10 MB)" }, 413);
  }
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field required" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return c.json({ error: "File too large (max 10 MB)" }, 413);
    }
    const result = await pinata.upload.public.file(file);
    return c.json({ data: { cid: result.cid, url: `ipfs://${result.cid}` } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to upload file");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// GET /v1/metadata/resolve?uri=...
metadata.get("/resolve", async (c) => {
  const uri = c.req.query("uri");
  if (!uri) return c.json({ error: "uri query param required" }, 400);

  // SSRF guard — only allow ipfs://, data:, and https:// URIs.
  // Block file://, gopher://, http://, and private/internal IP ranges.
  if (!uri.startsWith("ipfs://") && !uri.startsWith("data:")) {
    let parsed: URL;
    try { parsed = new URL(uri); } catch {
      return c.json({ error: "Invalid URI" }, 400);
    }
    if (parsed.protocol !== "https:") {
      return c.json({ error: "Only ipfs://, data:, and https:// URIs are supported" }, 400);
    }
    // Block private/internal IP ranges and loopback
    const privateRange = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fc00:|fe80:)/i;
    if (privateRange.test(parsed.hostname)) {
      return c.json({ error: "Internal addresses are not allowed" }, 400);
    }
  }

  const resolved = await resolveMetadata(uri);
  return c.json({ data: resolved });
});

export default metadata;
