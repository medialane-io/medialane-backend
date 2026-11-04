import { Hono } from "hono";
import { PinataSDK } from "pinata";
import { env } from "../../config/env.js";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";
import { resolveMetadata } from "../../discovery/index.js";
import { createLogger } from "../../utils/logger.js";
import { toErrorMessage } from "../../utils/error.js";
import { isPrivateOrInsecureUrl } from "../../utils/ssrf.js";

const log = createLogger("routes:metadata");
const metadata = new Hono();


const pinata = new PinataSDK({
  pinataJwt: env.PINATA_JWT,
  pinataGateway: env.PINATA_GATEWAY,
});

metadata.get("/signed-url", async (c) => {
  try {
    const url = await pinata.upload.public.createSignedURL({ expires: 120, maxFileSize: MAX_UPLOAD_BYTES });
    return c.json({ data: { url } });
  } catch (err: unknown) {
    const msg = toErrorMessage(err);
    log.error({ err }, `Failed to create signed URL: ${msg}`);
    const status = msg.includes("403") || msg.includes("plan limits") ? 403 : 500;
    return c.json({ error: "Uploads are temporarily unavailable. Please try again in a moment." }, status);
  }
});

metadata.post("/upload", async (c) => {
  try {
    const raw = await c.req.text();
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
    log.error({ err }, `Failed to upload metadata: ${toErrorMessage(err)}`);
    return c.json({ error: "We could not save that metadata. Please try again." }, 500);
  }
});

metadata.post("/upload-file", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field required" }, 400);
    }

    const result = await pinata.upload.public.file(file);
    return c.json({ data: { cid: result.cid, url: `ipfs://${result.cid}` } }, 201);
  } catch (err: unknown) {
    log.error({ err }, `Failed to upload file: ${toErrorMessage(err)}`);
    return c.json({ error: "That file could not be uploaded. Please try again." }, 500);
  }
});

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
  for (const f of files) {
    if (!f?.name?.trim() || !/^[\w.-]+$/.test(f.name)) {
      return c.json({ error: "Every file needs a name (letters, digits, dot, dash, underscore only)" }, 400);
    }
    if (f.content === undefined) {
      return c.json({ error: `File "${f.name}" is missing content` }, 400);
    }
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
      return c.json({ error: "That upload could not be completed. Please try again." }, 502);
    }
    const json = (await res.json()) as { IpfsHash: string };
    return c.json({ data: { cid: json.IpfsHash, baseUri: `ipfs://${json.IpfsHash}/` } }, 201);
  } catch (err: unknown) {
    log.error({ err }, "Failed to upload directory");
    return c.json({ error: "That upload could not be completed. Please try again." }, 500);
  }
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
