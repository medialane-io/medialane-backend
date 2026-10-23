import { type Chain, type Prisma, type TokenStandard } from "@prisma/client";
import { chainCallAt } from "../chainRead/call.js";
import { detectStandard, readCollectionInfo, readOwner } from "../chainRead/collectionInfo.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { worker } from "./worker.js";
import { resolveMetadata } from "../discovery/index.js";
import { metadataAttributes } from "../utils/metadataAttributes.js";

const log = createLogger("orchestrator:collection-metadata");

const bestEffort = <T>(read: Promise<T>, fallback: T): Promise<T> => read.catch(() => fallback);

/** The on-chain base URI when the contract exposes one, else the one indexed from its factory event. */
export function resolveCollectionBaseUri(onchain: string, stored: string | null | undefined): string {
  return onchain || stored || "";
}

export async function handleCollectionMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
}): Promise<void> {
  const { contractAddress } = payload;
  const chain = payload.chain as Chain;

  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { metadataStatus: true, name: true, symbol: true, owner: true, image: true, attributes: true, service: true, standard: true, baseUri: true, description: true },
  });

  const alreadyComplete =
    existing?.metadataStatus === "FETCHED" &&
    existing?.owner !== null &&
    (existing?.service !== "mip-erc1155" || existing?.image !== null) &&
    (existing?.service !== "mip-erc721" || existing?.image !== null);

  if (alreadyComplete) {
    log.debug({ chain, contractAddress }, "Collection metadata already fetched, skipping");
    return;
  }

  if (existing?.service === "mip-erc1155" || existing?.standard === "ERC1155") {
    const isOwnCollection = isOwnService(existing?.service);
    const missingCanonicalFields =
      !existing?.name ||
      !existing?.symbol ||
      !existing?.baseUri ||
      !existing?.owner;

    let onchainName = "";
    let onchainSymbol = "";
    let onchainBaseUri = "";
    let onchainOwner: string | null = null;

    if (missingCanonicalFields) {
      const onchainInfo = await fetchCollectionOnChainInfo(contractAddress, !isOwnCollection);
      onchainName = onchainInfo.name;
      onchainSymbol = onchainInfo.symbol;
      onchainBaseUri = onchainInfo.baseUri;

      if (isOwnCollection && !onchainName && !onchainSymbol && !existing?.name && !existing?.symbol) {
        log.warn({ chain, contractAddress }, "On-chain name/symbol read failed for own ERC1155 collection");
        await prisma.collection.update({
          where: { chain_contractAddress: { chain, contractAddress } },
          data: { metadataStatus: "FAILED" },
        });
        return;
      }

      onchainOwner = await bestEffort(readOwner(chainCallAt("latest"), contractAddress), null);
    }

    const canonicalBaseUri = existing?.baseUri || onchainBaseUri || "";

    let resolvedImage: string | null = existing.image ?? null;
    let resolvedDescription: string | null = existing.description ?? null;
    let metadataFetched = true;
    let resolvedAttributes = metadataAttributes(existing.attributes ? { attributes: existing.attributes } : null);
    if (canonicalBaseUri && (!resolvedImage || !resolvedDescription || !resolvedAttributes)) {
      const fetched = await fetchCollectionMetadataJson(canonicalBaseUri);
      metadataFetched = fetched !== null;
      resolvedAttributes = resolvedAttributes ?? metadataAttributes(fetched);
      resolvedImage = resolvedImage ?? metadataString(fetched, "image");
      resolvedDescription = resolvedDescription ?? metadataString(fetched, "description");
    }

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        standard: "ERC1155",
        metadataStatus: metadataFetched ? "FETCHED" : "FAILED",
        name: existing?.name || onchainName || undefined,
        symbol: existing?.symbol || onchainSymbol || undefined,
        baseUri: canonicalBaseUri || undefined,
        owner: existing?.owner || onchainOwner || undefined,
        image: resolvedImage ?? undefined,
        description: resolvedDescription ?? undefined,
        attributes: (resolvedAttributes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    log.debug({ chain, contractAddress, resolvedImage, metadataFetched }, "ERC1155 collection metadata updated");
    return;
  }

  if (!existing) {
    log.warn({ chain, contractAddress }, "Metadata fetch queued for unknown collection — skipping");
    return;
  }
  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: { metadataStatus: "FETCHING" },
  });

  const isOwnCollection = isOwnService(existing?.service);

  try {
    const onchain = await fetchCollectionOnChainInfo(contractAddress, !isOwnCollection);
    const { name, symbol } = onchain;
    const baseUri = resolveCollectionBaseUri(onchain.baseUri, existing?.baseUri);

    if (isOwnCollection && !name && !symbol && !existing?.name && !existing?.symbol) {
      throw new Error("On-chain name/symbol read failed for own collection — no legacy fallback available");
    }

    const collectionMetadata = baseUri ? await fetchCollectionMetadataJson(baseUri) : null;

    const resolvedName = name || existing?.name || "";
    const { description, image, owner: intentOwner } = await findIntentMetadata(resolvedName);

    const onChainOwner = await bestEffort(readOwner(chainCallAt("latest"), contractAddress), null);

    const detected = await detectTokenStandard(contractAddress);
    const standard = existing?.service
      ? resolveStandardByService(existing.service, detected ?? existing.standard)
      : detected ?? existing!.standard;

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        name: name || existing?.name || null,
        symbol: symbol || existing?.symbol || null,
        baseUri: baseUri || null,
        description: metadataString(collectionMetadata, "description") ?? description ?? undefined,
        image: metadataString(collectionMetadata, "image") ?? existing?.image ?? image ?? undefined,
        attributes: (metadataAttributes(collectionMetadata) ?? undefined) as Prisma.InputJsonValue | undefined,
        owner: existing?.owner ?? intentOwner ?? onChainOwner ?? undefined,
        standard,
        metadataStatus: baseUri && !collectionMetadata ? "FAILED" : "FETCHED",
      },
    });

    log.debug(
      { chain, contractAddress, name, symbol, baseUri, description },
      "Collection on-chain metadata fetched"
    );
  } catch (err) {
    log.error({ err, chain, contractAddress }, "Collection metadata fetch failed");

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: { metadataStatus: "FAILED" },
    });
    throw err;
  }
}

export async function fetchCollectionMetadataJson(baseUri: string): Promise<Record<string, unknown> | null> {
  if (!baseUri.endsWith("/")) return resolveMetadata(baseUri);
  const inDirectory = await resolveMetadata(`${baseUri}collection.json`);
  if (inDirectory || !baseUri.startsWith("ipfs://")) return inDirectory;
  return resolveMetadata(baseUri.replace(/\/+$/, ""));
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function resolveStandardByService(
  service: string | null | undefined,
  detected: TokenStandard
): TokenStandard {
  if (
    service === "mip-erc721" ||
    service === "pop-protocol" ||
    service === "drop-collection"
  ) return "ERC721";
  return detected;
}

export function detectTokenStandard(contractAddress: string): Promise<TokenStandard | null> {
  return bestEffort(detectStandard(chainCallAt("latest"), contractAddress), null);
}

function isOwnService(service: string | null | undefined): boolean {
  return service != null && !service.startsWith("external-");
}

function fetchCollectionOnChainInfo(
  contractAddress: string,
  allowLegacyFallback: boolean
): Promise<{ name: string; symbol: string; baseUri: string }> {
  return bestEffort(
    readCollectionInfo(chainCallAt("latest"), contractAddress, { legacy: allowLegacyFallback }),
    { name: "", symbol: "", baseUri: "" },
  );
}

async function findIntentMetadata(
  name: string
): Promise<{ description: string | null; image: string | null; owner: string | null }> {
  if (!name) return { description: null, image: null, owner: null };
  try {
    const intent = await prisma.transactionIntent.findFirst({
      where: {
        type: "CREATE_COLLECTION",
        typedData: { path: ["name"], equals: name } as Prisma.JsonFilter,
      },
      orderBy: { createdAt: "desc" },
      select: { typedData: true },
    });

    if (!intent) return { description: null, image: null, owner: null };
    const td = intent.typedData as Record<string, unknown>;
    return {
      description: typeof td.description === "string" && td.description ? td.description : null,
      image: typeof td.image === "string" && td.image ? td.image : null,
      owner: typeof td.owner === "string" && td.owner ? td.owner : null,
    };
  } catch {
    return { description: null, image: null, owner: null };
  }
}
