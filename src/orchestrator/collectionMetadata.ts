import { Contract, shortString } from "starknet";
import { type Chain, type Prisma } from "@prisma/client";
import { createProvider } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:collection-metadata");

// ByteArray ABI for modern OZ contracts (ERC-721 name/symbol/base_uri)
const BYTEARRAY_STRUCT = {
  type: "struct",
  name: "core::byte_array::ByteArray",
  members: [
    { name: "data", type: "core::array::Array::<core::felt252>" },
    { name: "pending_word", type: "core::felt252" },
    { name: "pending_word_len", type: "core::integer::u32" },
  ],
};

const ERC721_INFO_ABI_BYTEARRAY = [
  BYTEARRAY_STRUCT,
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "base_uri",
    inputs: [],
    outputs: [{ type: "core::byte_array::ByteArray" }],
    state_mutability: "view",
  },
];

// felt252 fallback ABI for older contracts
const ERC721_INFO_ABI_FELT = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "base_uri",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
];

/**
 * Fetch and index on-chain metadata for a Collection:
 * - name() and symbol() from the ERC-721 contract
 * - base_uri() stored for reference
 *
 * description and image are populated separately by the STATS_UPDATE job
 * once tokens in the collection have their metadata fetched.
 */
export async function handleCollectionMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
}): Promise<void> {
  const { contractAddress } = payload;
  const chain = payload.chain as Chain;

  // Guard: skip if already fetched (avoid redundant on-chain calls)
  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { metadataStatus: true, name: true, symbol: true },
  });

  if (existing?.metadataStatus === "FETCHED") {
    log.debug({ chain, contractAddress }, "Collection metadata already fetched, skipping");
    return;
  }

  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: { metadataStatus: "FETCHING" },
  });

  try {
    const { name, symbol, baseUri } = await fetchCollectionOnChainInfo(contractAddress);

    // Look up description + image from the most recent matching CREATE_COLLECTION intent
    const resolvedName = existing?.name ?? name;
    const { description, image } = await findIntentMetadata(resolvedName);

    const existingFull = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain, contractAddress } },
      select: { image: true },
    });

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        // Preserve admin-set values — only fill in if not already set
        name: existing?.name ?? (name || null),
        symbol: existing?.symbol ?? (symbol || null),
        baseUri: baseUri || null,
        description: description ?? undefined,
        image: existingFull?.image ?? image ?? undefined,
        metadataStatus: "FETCHED",
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

async function fetchCollectionOnChainInfo(
  contractAddress: string
): Promise<{ name: string; symbol: string; baseUri: string }> {
  const provider = createProvider();

  // Try ByteArray ABI first, then felt252 fallback
  for (const abi of [ERC721_INFO_ABI_BYTEARRAY, ERC721_INFO_ABI_FELT]) {
    const contract = new Contract(abi as any, contractAddress, provider);
    try {
      const [nameRaw, symbolRaw, baseUriRaw] = await Promise.all([
        callView(contract, "name"),
        callView(contract, "symbol"),
        callView(contract, "base_uri"),
      ]);

      const name = decodeField(nameRaw);
      const symbol = decodeField(symbolRaw);
      const baseUri = decodeField(baseUriRaw);

      if (name || symbol) {
        return { name, symbol, baseUri };
      }
    } catch {
      // Try next ABI variant
    }
  }

  return { name: "", symbol: "", baseUri: "" };
}

async function callView(contract: Contract, fn: string): Promise<unknown> {
  try {
    return await (contract as any)[fn]();
  } catch {
    return null;
  }
}

function decodeField(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    // Already decoded (ByteArray returns string directly)
    return raw;
  }
  if (typeof raw === "bigint") {
    // felt252 — decode as short string
    try {
      return shortString.decodeShortString(raw.toString());
    } catch {
      return raw.toString();
    }
  }
  return "";
}

/**
 * Search for the most recent CREATE_COLLECTION intent whose stored name matches
 * and extract description + image if present.
 */
async function findIntentMetadata(
  name: string
): Promise<{ description: string | null; image: string | null }> {
  if (!name) return { description: null, image: null };
  try {
    const intent = await prisma.transactionIntent.findFirst({
      where: {
        type: "CREATE_COLLECTION",
        typedData: { path: ["name"], equals: name } as Prisma.JsonFilter,
      },
      orderBy: { createdAt: "desc" },
      select: { typedData: true },
    });

    if (!intent) return { description: null, image: null };
    const td = intent.typedData as Record<string, unknown>;
    return {
      description: typeof td.description === "string" && td.description ? td.description : null,
      image: typeof td.image === "string" && td.image ? td.image : null,
    };
  } catch {
    return { description: null, image: null };
  }
}
