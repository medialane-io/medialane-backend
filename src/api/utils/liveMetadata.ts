import type { Chain } from "@prisma/client";
import { resolveMetadata } from "../../discovery/index.js";
import { fetchTokenUri } from "../../orchestrator/metadata.js";

interface LiveMetadataDeps {
  tokenUri: (contractAddress: string, tokenId: string, chain: Chain) => Promise<string | null>;
  metadata: (uri: string) => Promise<Record<string, unknown> | null>;
}

const defaultDeps: LiveMetadataDeps = { tokenUri: fetchTokenUri, metadata: resolveMetadata };

export interface LiveMetadata {
  description: string | null;
  externalUrl: string | null;
}

const NONE: LiveMetadata = { description: null, externalUrl: null };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** The description and external URL a token's own metadata file carries (cached by resolveMetadata). Nulls when unavailable. */
export async function liveMetadata(
  chain: Chain,
  contractAddress: string,
  tokenId: string,
  storedTokenUri: string | null,
  deps: LiveMetadataDeps = defaultDeps,
): Promise<LiveMetadata> {
  try {
    const uri = storedTokenUri ?? (await deps.tokenUri(contractAddress, tokenId, chain));
    if (!uri) return NONE;
    const metadata = await deps.metadata(uri);
    return { description: text(metadata?.description), externalUrl: text(metadata?.external_url) };
  } catch {
    return NONE;
  }
}
