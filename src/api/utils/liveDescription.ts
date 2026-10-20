import type { Chain } from "@prisma/client";
import { resolveMetadata } from "../../discovery/index.js";
import { fetchTokenUri } from "../../orchestrator/metadata.js";

interface LiveDescriptionDeps {
  tokenUri: (contractAddress: string, tokenId: string, chain: Chain) => Promise<string | null>;
  metadata: (uri: string) => Promise<Record<string, unknown> | null>;
  timeoutMs: number;
}

const defaultDeps: LiveDescriptionDeps = { tokenUri: fetchTokenUri, metadata: resolveMetadata, timeoutMs: 3000 };

/** A token's description, read from its own metadata (cached by resolveMetadata). Null when unavailable. */
export async function liveDescription(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  storedTokenUri: string | null,
  deps: LiveDescriptionDeps = defaultDeps,
): Promise<string | null> {
  const read = async () => {
    const uri = storedTokenUri ?? (await deps.tokenUri(contractAddress, tokenId, chain));
    if (!uri) return null;
    const description = (await deps.metadata(uri))?.description;
    return typeof description === "string" && description.trim() ? description : null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs); });
  try {
    return await Promise.race([read().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
