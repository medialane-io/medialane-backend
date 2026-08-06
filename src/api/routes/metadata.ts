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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const result = await pinata.upload.public.json(parsed);
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

const MAX_DIRECTORY_FILES = 2001; // 2000 items + collection.json
const MAX_DIRECTORY_BYTES = 5 * 1024 * 1024; // 5 MB total across every file

/**
 * Builds the multipart form for Pinata's directory-pin endpoint. Pure
 * function (no network) so the directory-vs-flat-pin invariant is unit
 * testable without a live Pinata key: Pinata pins a DIRECTORY only when
 * every file shares a common folder prefix in its name AND
 * `pinataOptions.wrapWithDirectory` is `false` — it then returns the CID
 * of that folder, so children resolve at `<cid>/<name>`. Flat names or
 * `wrap:true` get rejected with "More than one file ... provided for
 * pinning". Do not change this shape without re-verifying against Pinata.
 */
export function buildDirectoryPinForm(
  files: { name: string; content: unknown }[],
  folder: string,
): FormData {
  const form = new FormData();
  for (const { name, content } of files) {
    const blob = new Blob([JSON.stringify(content)], { type: "application/json" });
    form.append("file", blob, `${folder}/${name}`);
  }
  form.append("pinataOptions", JSON.stringify({ wrapWithDirectory: false }));
  form.append("pinataMetadata", JSON.stringify({ name: `${folder}-${Date.now()}` }));
  return form;
}

// POST /v1/metadata/upload-directory — Pin a set of named JSON files together
// under one folder CID (base_uri = ipfs://<cid>/, each file at ipfs://<cid>/<name>).
// Generic: this route doesn't know about asset/drop metadata shape, callers
// send already-built JSON documents keyed by filename.
metadata.post("/upload-directory", async (c) => {
  const jwt = env.PINATA_JWT;
  if (!jwt) return c.json({ error: "Pinata not configured" }, 500);

  const body = await c.req.json().catch(() => null) as {
    files?: { name?: string; content?: unknown }[];
  } | null;
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return c.json({ error: "files[] required" }, 400);
  }
  if (files.length > MAX_DIRECTORY_FILES) {
    return c.json({ error: `Max ${MAX_DIRECTORY_FILES} files per directory` }, 400);
  }
  for (const f of files) {
    if (!f?.name?.trim() || !/^[\w.-]+$/.test(f.name)) {
      return c.json({ error: "Every file needs a name (letters, digits, dot, dash, underscore only)" }, 400);
    }
    if (f.content === undefined) {
      return c.json({ error: `File "${f.name}" is missing content` }, 400);
    }
  }
  const totalBytes = files.reduce((sum, f) => sum + JSON.stringify(f.content).length, 0);
  if (totalBytes > MAX_DIRECTORY_BYTES) {
    return c.json({ error: "Payload too large (max 5 MB total)" }, 413);
  }

  try {
    const form = buildDirectoryPinForm(
      files as { name: string; content: unknown }[],
      "dir",
    );
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, text }, "Pinata directory pin failed");
      return c.json({ error: `Pinata error: ${text}` }, 502);
    }
    const json = (await res.json()) as { IpfsHash: string };
    return c.json({ data: { cid: json.IpfsHash, baseUri: `ipfs://${json.IpfsHash}/` } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to upload directory");
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
