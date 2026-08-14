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
