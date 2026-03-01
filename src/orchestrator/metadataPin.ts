import { PinataSDK } from "pinata";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:metadataPin");

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

/**
 * Pin an already-uploaded IPFS CID to Pinata so it is persistently hosted.
 * Enqueued by the metadata fetch handler after a token URI resolves to an
 * ipfs:// URI so the content remains available even if the origin disappears.
 */
export async function handleMetadataPin(payload: { cid: string }): Promise<void> {
  const { cid } = payload;

  if (!cid) {
    log.warn("METADATA_PIN job missing cid — skipping");
    return;
  }

  log.debug({ cid }, "Pinning CID to Pinata");
  await getPinata().upload.public.cid(cid);
  log.info({ cid }, "CID pinned successfully");
}
