import { type Chain, type Prisma } from "@prisma/client";
import { chainCallAt } from "../chainRead/call.js";
import { readTokenUri } from "../chainRead/tokenUri.js";
import prisma from "../db/client.js";
import { resolveMetadata } from "../discovery/index.js";
import { createLogger } from "../utils/logger.js";
import { attributesArraySchema, tokenFields, withoutNulCharacters } from "../utils/metadataAttributes.js";
import { storedImage, storedTokenUri } from "../utils/onchainContent.js";


const log = createLogger("orchestrator:metadata");

export async function handleMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
  tokenId: string;
}): Promise<void> {
  const { contractAddress, tokenId } = payload;
  const chain = payload.chain as Chain;

  await prisma.token.updateMany({
    where: { chain, contractAddress, tokenId, metadataStatus: { in: ["PENDING", "FAILED"] } },
    data: { metadataStatus: "FETCHING" },
  });

  try {
    const tokenUri = await fetchTokenUri(contractAddress, tokenId, chain);

    if (!tokenUri) throw new Error("No tokenURI found");

    const metadata = withoutNulCharacters(await resolveMetadata(tokenUri));

    const rawAttrs = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
    const attrsParsed = attributesArraySchema.safeParse(rawAttrs);
    const _attrs = attrsParsed.success ? attrsParsed.data : [];
    if (!attrsParsed.success) {
      log.warn({ chain, contractAddress, tokenId, issues: attrsParsed.error.issues.length }, "Token attributes failed validation — dropping invalid entries");
    }

    await prisma.token.updateMany({
      where: { chain, contractAddress, tokenId },
      data: {
        tokenUri: storedTokenUri(tokenUri),
        metadataStatus: metadata ? "FETCHED" : "FAILED",
        name: metadata?.name ?? null,
        image: storedImage(metadata?.image, chain, contractAddress, tokenId),
        animationUrl: (metadata?.animation_url as string | undefined) ?? null,
        attributes: _attrs.length > 0 ? (_attrs as Prisma.InputJsonValue) : undefined,
        ...tokenFields(metadata, _attrs),
      },
    });

    log.debug({ chain, contractAddress, tokenId, tokenUri }, "Metadata fetched");
  } catch (err) {
    log.error({ err, chain, contractAddress, tokenId }, "Metadata fetch failed");
    await prisma.token.updateMany({
      where: { chain, contractAddress, tokenId },
      data: { metadataStatus: "FAILED" },
    });
    throw err;
  }
}

export async function fetchTokenUri(
  contractAddress: string,
  tokenId: string,
  chain: Chain
): Promise<string | null> {
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { standard: true, service: true },
  });
  return readTokenUri(chainCallAt("latest"), contractAddress, tokenId, col);
}
