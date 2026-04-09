import { Contract, shortString } from "starknet";
import { type Chain } from "@prisma/client";
import { z } from "zod";
import { createProvider } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { resolveMetadata } from "../discovery/index.js";
import { createLogger } from "../utils/logger.js";

// Validated attribute shape — each entry must have trait_type (string) and
// value (string | number | boolean). Unknown shapes are dropped to prevent
// arbitrary data from landing in the DB.
const attributeSchema = z.object({
  trait_type: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  display_type: z.string().optional(),
}).passthrough();

const attributesArraySchema = z.array(attributeSchema);

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

// ERC-1155 metadata ABI — ByteArray variant
const ERC1155_METADATA_ABI_BYTEARRAY = [
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
    name: "uri",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
];

// ERC-1155 metadata ABI — Array<felt252> fallback
const ERC1155_METADATA_ABI_FELT_ARRAY = [
  {
    type: "function",
    name: "uri",
    inputs: [{ name: "token_id", type: "core::integer::u256" }],
    outputs: [{ type: "core::array::Array::<core::felt252>" }],
    state_mutability: "view",
  },
];

// ABI variants tried in order: ERC-721 ByteArray → ERC-721 felt array → ERC-1155 ByteArray → ERC-1155 felt array
// Each entry pairs an ABI with the function names it exposes.
const ABI_VARIANTS: Array<{ abi: any[]; fns: string[] }> = [
  { abi: ERC721_METADATA_ABI_BYTEARRAY,   fns: ["token_uri", "tokenURI"] },
  { abi: ERC721_METADATA_ABI_FELT_ARRAY,  fns: ["token_uri", "tokenURI"] },
  { abi: ERC1155_METADATA_ABI_BYTEARRAY,  fns: ["uri"] },
  { abi: ERC1155_METADATA_ABI_FELT_ARRAY, fns: ["uri"] },
];

// Cache the winning { abi, fn } pair per contract to skip failing variants on repeat calls.
type AbiCacheEntry = { abi: any[]; fn: string };
const contractAbiCache = new Map<string, AbiCacheEntry>();

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
    const tokenUri = await fetchTokenUri(contractAddress, tokenId, chain);

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

    // Helper: scan OpenSea-style attributes array for a trait value
    const _findAttr = (attrs: unknown[], name: string): string | null =>
      ((attrs ?? []).find(
        (a: any) =>
          typeof a?.trait_type === "string" &&
          a.trait_type.toLowerCase() === name.toLowerCase()
      ) as any)?.value ?? null;

    const rawAttrs = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
    const attrsParsed = attributesArraySchema.safeParse(rawAttrs);
    const _attrs = attrsParsed.success ? attrsParsed.data : [];
    if (!attrsParsed.success) {
      log.warn({ chain, contractAddress, tokenId, issues: attrsParsed.error.issues.length }, "Token attributes failed validation — dropping invalid entries");
    }

    await prisma.token.updateMany({
      where: { chain, contractAddress, tokenId },
      data: {
        tokenUri,
        metadataStatus: metadata ? "FETCHED" : "FAILED",
        name: metadata?.name ?? null,
        description: metadata?.description ?? null,
        image: metadata?.image ?? null,
        attributes: _attrs.length > 0 ? (_attrs as any) : undefined,
        ipType:
          (metadata?.properties as any)?.ip_type ??
          (metadata as any)?.ip_type ??
          _findAttr(_attrs, "ip type"),
        licenseType:
          (metadata?.properties as any)?.license_type ??
          (metadata as any)?.license_type ??
          _findAttr(_attrs, "license"),
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
  tokenId: string,
  chain: Chain
): Promise<string | null> {
  const provider = createProvider();

  // Convert tokenId to u256 (low, high)
  const tokenIdBig = BigInt(tokenId);
  const low = tokenIdBig & ((1n << 128n) - 1n);
  const high = tokenIdBig >> 128n;
  const u256 = { low: low.toString(), high: high.toString() };

  // Seed the in-memory ABI cache from Collection.standard when cold (e.g. after a deploy).
  // For known ERC-1155 contracts this skips the two failing ERC-721 probe calls that would
  // otherwise precede the successful ERC-1155 ByteArray probe.
  if (!contractAbiCache.has(contractAddress)) {
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain, contractAddress } },
      select: { standard: true },
    });
    if (col?.standard === "ERC1155") {
      contractAbiCache.set(contractAddress, { abi: ERC1155_METADATA_ABI_BYTEARRAY, fn: "uri" });
    } else if (col?.standard === "ERC721") {
      contractAbiCache.set(contractAddress, { abi: ERC721_METADATA_ABI_BYTEARRAY, fn: "token_uri" });
    }
    // UNKNOWN / null: fall through to full probe below
  }

  // If we already know which ABI + function works for this contract, use it directly.
  const cached = contractAbiCache.get(contractAddress);
  if (cached) {
    try {
      const contract = new Contract(cached.abi as any, contractAddress, provider);
      const result = await (contract as any)[cached.fn](u256);
      if (result != null) {
        let uri = decodeTokenUri(result);
        if (uri) {
          if (cached.fn === "uri") uri = resolveErc1155Uri(uri, tokenId);
          return uri;
        }
      }
    } catch {
      // Cache miss — fall through to full probe below
      contractAbiCache.delete(contractAddress);
    }
  }

  // Probe all variants in order: ERC-721 ByteArray, ERC-721 felt array, ERC-1155 ByteArray, ERC-1155 felt array
  for (const { abi, fns } of ABI_VARIANTS) {
    const contract = new Contract(abi as any, contractAddress, provider);
    for (const fn of fns) {
      try {
        const result = await (contract as any)[fn](u256);
        if (result != null) {
          let uri = decodeTokenUri(result);
          if (uri) {
            contractAbiCache.set(contractAddress, { abi, fn });
            if (fn === "uri") uri = resolveErc1155Uri(uri, tokenId);
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

/**
 * EIP-1155 {id} substitution: replace `{id}` in the URI template with the
 * lowercase hex-encoded token ID, zero-padded to 64 characters.
 * If the URI contains no `{id}`, it is returned unchanged.
 */
function resolveErc1155Uri(template: string, tokenId: string): string {
  if (!template.includes("{id}")) return template;
  const hex = BigInt(tokenId).toString(16).padStart(64, "0");
  return template.replace("{id}", hex);
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
