import { resolveMetadata } from "../../discovery/index.js";

interface LinkedMetadataDeps {
  metadata: (uri: string) => Promise<Record<string, unknown> | null>;
  timeoutMs: number;
}

const defaultDeps: LinkedMetadataDeps = { metadata: resolveMetadata, timeoutMs: 10_000 };

export interface LinkedMetadata {
  description: string | null;
  externalUrl: string | null;
}

const NONE: LinkedMetadata = { description: null, externalUrl: null };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export async function linkedMetadata(
  tokenUri: string | null,
  deps: LinkedMetadataDeps = defaultDeps,
): Promise<LinkedMetadata> {
  if (!tokenUri) return NONE;
  const read = async (): Promise<LinkedMetadata> => {
    const metadata = await deps.metadata(tokenUri);
    return { description: text(metadata?.description), externalUrl: text(metadata?.external_url) };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LinkedMetadata>((resolve) => { timer = setTimeout(() => resolve(NONE), deps.timeoutMs); });
  try {
    return await Promise.race([read().catch(() => NONE), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
