import prisma from "../db/client.js";

const IPFS_TTL = 7 * 24 * 3600; // 7 days
const HTTP_TTL = 24 * 3600;      // 24 hours

export async function getCachedMetadata(
  uri: string
): Promise<Record<string, unknown> | null> {
  const row = await prisma.metadataCache.findUnique({ where: { uri } });
  if (!row) return null;

  const ageSeconds = (Date.now() - row.fetchedAt.getTime()) / 1000;
  if (ageSeconds > row.ttlSeconds) return null;

  return row.content as Record<string, unknown> | null;
}

export async function setCachedMetadata(
  uri: string,
  resolvedUrl: string | null,
  content: Record<string, unknown> | null,
  isIpfs: boolean
): Promise<void> {
  const ttlSeconds = isIpfs ? IPFS_TTL : HTTP_TTL;
  await prisma.metadataCache.upsert({
    where: { uri },
    create: {
      uri,
      resolvedUrl,
      content: (content ?? undefined) as any,
      fetchedAt: new Date(),
      ttlSeconds,
    },
    update: {
      resolvedUrl,
      content: (content ?? undefined) as any,
      fetchedAt: new Date(),
      ttlSeconds,
    },
  });
}
