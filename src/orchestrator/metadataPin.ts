import { PinataSDK } from "pinata";
import { env } from "../config/env.js";

let _pinata: PinataSDK | null = null;

function getPinata(): PinataSDK {
  if (!_pinata) {
    _pinata = new PinataSDK({
      pinataJwt: env.PINATA_JWT,
      pinataGateway: env.PINATA_GATEWAY,
    });
  }
  return _pinata;
}

export async function uploadJson(data: Record<string, unknown>): Promise<string> {
  const upload = await getPinata().upload.public.json(data);
  return `ipfs://${upload.cid}`;
}

export async function createSignedUpload(input: {
  name: string;
  size: number;
  type: string;
  keyvalues: Record<string, string>;
  expiresInSeconds?: number;
}): Promise<string> {
  return getPinata().upload.public.createSignedURL({
    expires: input.expiresInSeconds ?? 600,
    maxFileSize: input.size,
    name: input.name,
    keyvalues: input.keyvalues,
    ...(input.type ? { mimeTypes: [input.type] } : {}),
  });
}

export async function findPinnedFile(
  cid: string,
): Promise<{ size: number; keyvalues: Record<string, string> } | null> {
  const listed = (await getPinata().files.public.list().cid(cid).limit(1)) as {
    files?: { size: number; keyvalues?: Record<string, string> }[];
  };
  const file = listed.files?.[0];
  return file ? { size: file.size, keyvalues: file.keyvalues ?? {} } : null;
}
