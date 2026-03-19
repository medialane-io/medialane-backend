import { Contract, shortString } from "starknet";
import { type Chain } from "@prisma/client";
import { createProvider } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { resolveMetadata } from "../discovery/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:metadata");

// ERC721 metadata ABI — ByteArray variant (OZ v0.14+, most modern contracts)
// The struct definition is required so starknet.js decodes the ByteArray into a string.
const ERC721_METADATA_ABI_BYTEARRAY = [
  {
    type: "struct",
    name: "core::byte_array::ByteArray",
    members: [
      { name: "data", type: "core::array::Array::<core::felt252>" },
      { name: "pending_word", type: "core::felt252" },
      { name: "pending_word_len", type: "core::integer::u32" },
    ],
  },
  {
    type: "function",
    name: "token_uri",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
];

// Legacy fallback ABI — Array<felt252> (older contracts)
const ERC721_METADATA_ABI_FELT_ARRAY = [
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

// Cache which ABI variant worked for a given contract address so subsequent
// token_uri calls skip the failing variant entirely.
const contractAbiCache = new Map<string, typeof ERC721_METADATA_ABI_BYTEARRAY>();

export async function handleMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
  tokenId: string;
}): Promise<void> {
  const { contractAddress, tokenId } = payload;
  const chain = payload.chain as Chain;

  // Mark as fetching
  await prisma.token.updateMany({
    where: { chain, contractAddress, tokenId, metadataStatus: { in: ["PENDING", "FAILED"] } },
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

  // Convert tokenId to u256 (low, high)
  const tokenIdBig = BigInt(tokenId);
  const low = tokenIdBig & ((1n << 128n) - 1n);
  const high = tokenIdBig >> 128n;
  const u256 = { low: low.toString(), high: high.toString() };

  // If we already know which ABI works for this contract, try it first.
  // Otherwise iterate both and cache the winner.
  const knownAbi = contractAbiCache.get(contractAddress);
  const abisToTry = knownAbi
    ? [knownAbi]
    : [ERC721_METADATA_ABI_BYTEARRAY, ERC721_METADATA_ABI_FELT_ARRAY];

  for (const abi of abisToTry) {
    const contract = new Contract(abi as any, contractAddress, provider);
    for (const fn of ["token_uri", "tokenURI"]) {
      try {
        const result = await (contract as any)[fn](u256);
        if (result != null) {
          const uri = decodeTokenUri(result);
          if (uri) {
            contractAbiCache.set(contractAddress, abi);
            return uri;
          }
        }
      } catch {
        // Try next variant
      }
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
