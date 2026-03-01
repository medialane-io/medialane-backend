import { Contract, shortString } from "starknet";
import { type Chain } from "@prisma/client";
import { createProvider } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { resolveMetadata } from "../discovery/index.js";
import { enqueueJob } from "./queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:metadata");

// Minimal ERC721 metadata ABI
const ERC721_METADATA_ABI = [
  {
    type: "function",
    name: "token_uri",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::array::Array::<core::felt252>" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::array::Array::<core::felt252>" }],
    state_mutability: "view",
  },
];

export async function handleMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
  tokenId: string;
}): Promise<void> {
  const { contractAddress, tokenId } = payload;
  const chain = payload.chain as Chain;

  // Mark as fetching
  await prisma.token.updateMany({
    where: { chain, contractAddress, tokenId, metadataStatus: "PENDING" },
    data: { metadataStatus: "FETCHING" },
  });

  try {
    const tokenUri = await fetchTokenUri(contractAddress, tokenId);

    if (!tokenUri) {
      log.warn({ chain, contractAddress, tokenId }, "No tokenURI found");
      await prisma.token.updateMany({
        where: { chain, contractAddress, tokenId },
        data: { metadataStatus: "FAILED" },
      });
      return;
    }

    // Fetch and parse metadata
    const metadata = await resolveMetadata(tokenUri);

    await prisma.token.updateMany({
      where: { chain, contractAddress, tokenId },
      data: {
        tokenUri,
        metadataStatus: metadata ? "FETCHED" : "FAILED",
        name: metadata?.name ?? null,
        description: metadata?.description ?? null,
        image: metadata?.image ?? null,
        attributes: metadata?.attributes ?? undefined,
        ipType: (metadata?.properties as any)?.ip_type ?? (metadata as any)?.ip_type ?? null,
        licenseType:
          (metadata?.properties as any)?.license_type ??
          (metadata as any)?.license_type ??
          null,
        commercialUse:
          (metadata?.properties as any)?.commercial_use ??
          (metadata as any)?.commercial_use ??
          null,
        author: (metadata?.properties as any)?.author ?? (metadata as any)?.author ?? null,
      },
    });

    // Enqueue persistent pin if the URI is on IPFS
    const ipfsMatch = tokenUri.match(/^ipfs:\/\/([^/]+)/);
    if (ipfsMatch) {
      await enqueueJob("METADATA_PIN", { cid: ipfsMatch[1] });
    }

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

async function fetchTokenUri(
  contractAddress: string,
  tokenId: string
): Promise<string | null> {
  const provider = createProvider();
  const contract = new Contract(
    ERC721_METADATA_ABI as any,
    contractAddress,
    provider
  );

  // Convert tokenId to u256 (low, high)
  const tokenIdBig = BigInt(tokenId);
  const low = tokenIdBig & ((1n << 128n) - 1n);
  const high = tokenIdBig >> 128n;

  const u256 = { low: low.toString(), high: high.toString() };

  // Try token_uri first, then tokenURI
  for (const fn of ["token_uri", "tokenURI"]) {
    try {
      const result = await (contract as any)[fn](u256);
      if (result) {
        return decodeTokenUri(result);
      }
    } catch {
      // Try next variant
    }
  }

  return null;
}

function decodeTokenUri(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    // Array of felts — decode as short strings joined
    try {
      const parts = raw.map((f: any) =>
        shortString.decodeShortString(f.toString())
      );
      return parts.join("");
    } catch {
      return raw.join("");
    }
  }
  return null;
}
