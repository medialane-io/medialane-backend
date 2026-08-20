import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PinataSDK } from "pinata";
import {
  isValidIpfsCidPath,
  resolveSafeImageContentType,
  MAX_IPFS_GATEWAY_RESPONSE_BYTES,
} from "@medialane/sdk";
import { env } from "../../config/env.js";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { isPrivateOrInsecureUrl } from "../../utils/ssrf.js";

const log = createLogger("routes:metadata");
const metadata = new Hono();

const MAX_JSON_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const pinata = new PinataSDK({
  pinataJwt: env.PINATA_JWT,
  pinataGateway: env.PINATA_GATEWAY,
});

const SIGNED_URL_MIME_TYPES: Record<"image" | "document" | "media", string[]> = {
  image: ["image/jpeg", "image/png", "image/gif", "image/svg+xml", "image/webp"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
    "application/rtf",
    "text/plain",
    "text/markdown",

    "application/octet-stream",
  ],
  media: [
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif",
    "video/mp4", "video/webm", "video/ogg",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/flac",
    "application/pdf",
  ],
};
const SIGNED_URL_MAX_BYTES: Record<"image" | "document" | "media", number> = {
  image: 10 * 1024 * 1024,
  document: 20 * 1024 * 1024,
  media: 100 * 1024 * 1024,
};

metadata.get("/signed-url", async (c) => {
  const kindParam = c.req.query("kind");
  const kind: "image" | "document" | "media" =
    kindParam === "document" ? "document" : kindParam === "media" ? "media" : "image";
  try {
    const url = await pinata.upload.public.createSignedURL({
      expires: 120,
      maxFileSize: SIGNED_URL_MAX_BYTES[kind],
      mimeTypes: SIGNED_URL_MIME_TYPES[kind],
    });
    return c.json({ data: { url } });
  } catch (err: unknown) {
    log.error({ err }, "Failed to create signed URL");
    const msg = toErrorMessage(err);
    const status = msg.includes("403") || msg.includes("plan limits") ? 403 : 500;
    return c.json({ error: msg }, status);
  }
});

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

  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif",

  "video/mp4", "video/webm", "video/ogg",

  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/flac",

  "application/pdf",

  "application/octet-stream",
]);

const ALLOWED_EXTENSIONS = /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|ogv|ogg|mp3|wav|flac|pdf|glb|gltf)$/i;

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

const MAX_DIRECTORY_FILES = 2001;
const MAX_DIRECTORY_BYTES = 5 * 1024 * 1024;

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

metadata.get("/image/*", async (c) => {
  const cidPath = c.req.path.replace(/^.*\/v1\/metadata\/image\//, "");
  if (!isValidIpfsCidPath(cidPath)) {
    return c.json({ error: "Invalid IPFS path" }, 400);
  }

  const url = `https://${env.PINATA_GATEWAY}/ipfs/${cidPath}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: env.PINATA_GATEWAY_TOKEN ? { "x-pinata-gateway-token": env.PINATA_GATEWAY_TOKEN } : {},
      signal: AbortSignal.timeout(18_000),
    });
  } catch {
    return c.json({ error: "Failed to fetch from IPFS" }, 502);
  }

  if (!upstream.ok) {
    return c.json({ error: "IPFS content unavailable" }, upstream.status as ContentfulStatusCode);
  }

  const upstreamContentType = upstream.headers.get("content-type") ?? "";
  const upstreamContentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (upstreamContentLength > MAX_IPFS_GATEWAY_RESPONSE_BYTES) {
    return c.json({ error: "IPFS content too large" }, 413);
  }
  if (!upstream.body) {
    return c.json({ error: "IPFS gateway returned no body" }, 502);
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IPFS_GATEWAY_RESPONSE_BYTES) {
      await reader.cancel();
      return c.json({ error: "IPFS content too large" }, 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const safeContentType = resolveSafeImageContentType(upstreamContentType);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": safeContentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    },
  });
});

metadata.get("/resolve", async (c) => {
  const uri = c.req.query("uri");
  if (!uri) return c.json({ error: "uri query param required" }, 400);

  if (!uri.startsWith("ipfs://") && !uri.startsWith("data:")) {
    if (isPrivateOrInsecureUrl(uri)) {
      return c.json({ error: "Only ipfs://, data:, and https:// URIs to public hosts are supported" }, 400);
    }
  }

  const resolved = await resolveMetadata(uri);
  return c.json({ data: resolved });
});

export default metadata;
