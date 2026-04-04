import { Hono } from "hono";
import { PinataSDK } from "pinata";
import { env } from "../../config/env.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { isPrivateOrInsecureUrl } from "../../utils/ssrf.js";

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

const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif",
  // Video
  "video/mp4", "video/webm", "video/ogg",
  // Audio
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/flac",
  // Documents
  "application/pdf",
  // Generic binary (e.g. 3D models) — name-checked below
  "application/octet-stream",
]);

const ALLOWED_EXTENSIONS = /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|ogv|ogg|mp3|wav|flac|pdf|glb|gltf)$/i;

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

    // MIME type allowlist — reject executables, HTML, scripts, etc.
    const mimeBase = file.type.split(";")[0].trim().toLowerCase();
    const nameOk = ALLOWED_EXTENSIONS.test(file.name);
    if (!ALLOWED_MIME_TYPES.has(mimeBase) && !nameOk) {
      return c.json({ error: "File type not allowed" }, 415);
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

  // SSRF guard — only allow ipfs://, data:, and https:// URIs pointing at public hosts.
  if (!uri.startsWith("ipfs://") && !uri.startsWith("data:")) {
    if (isPrivateOrInsecureUrl(uri)) {
      return c.json({ error: "Only ipfs://, data:, and https:// URIs to public hosts are supported" }, 400);
    }
  }

  const resolved = await resolveMetadata(uri);
  return c.json({ data: resolved });
});

export default metadata;
