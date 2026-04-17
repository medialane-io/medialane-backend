import { Contract, shortString } from "starknet";
import { type Chain, type Prisma, type TokenStandard } from "@prisma/client";
import { createProvider, normalizeAddress } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { worker } from "./worker.js";
import { ipfsToHttp } from "../utils/ipfs.js";

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

// ERC-165 interface IDs (as felt252 hex)
const INTERFACE_ID_ERC721  = "0x80ac58cd";
const INTERFACE_ID_ERC1155 = "0xd9b67a26";

const SUPPORTS_INTERFACE_ABI = [
  {
    type: "function",
    name: "supports_interface",
    inputs: [{ name: "interface_id", type: "core::felt252" }],
    outputs: [{ type: "core::bool" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "interfaceId", type: "core::felt252" }],
    outputs: [{ type: "core::bool" }],
    state_mutability: "view",
  },
];

const OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ type: "core::starknet::contract_address::ContractAddress" }],
    state_mutability: "view",
  },
];

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

  // Guard: skip only if already fetched AND owner is populated
  // Fetch all fields we'll need later in one round-trip (avoids a second query
  // for image/owner that was previously done separately as `existingFull`).
  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { metadataStatus: true, name: true, symbol: true, owner: true, image: true, source: true, baseUri: true, description: true },
  });

  // Skip if already fully resolved. For ERC1155_FACTORY collections, also re-run
  // if image is still null (base_uri JSON fetch may not have happened on the first pass).
  const alreadyComplete =
    existing?.metadataStatus === "FETCHED" &&
    existing?.owner !== null &&
    (existing?.source !== "ERC1155_FACTORY" || existing?.image !== null);

  if (alreadyComplete) {
    log.debug({ chain, contractAddress }, "Collection metadata already fetched, skipping");
    return;
  }

  // ERC1155_FACTORY collections: name, symbol, and base_uri are decoded directly from
  // the CollectionDeployed event by the indexer and written at index time — they are
  // the on-chain source of truth. Although v2 contracts expose name()/symbol()/base_uri()
  // view functions, we skip the RPC fetch here to avoid overwriting event-sourced data
  // and because detectTokenStandard() uses EVM ERC-165 IDs that don't match Starknet
  // OZ SRC5 interface IDs (would always return UNKNOWN). standard=ERC1155 is set directly.
  if (existing?.source === "ERC1155_FACTORY") {
    // Resolve image + description from the base_uri JSON if not already set.
    // base_uri points to an IPFS collection metadata JSON (OpenSea format):
    // { name, description, image, external_link }
    let resolvedImage: string | null = existing.image ?? null;
    let resolvedDescription: string | null = existing.description ?? null;
    if (existing?.baseUri && (!resolvedImage || !resolvedDescription)) {
      try {
        const metaUrl = ipfsToHttp(existing.baseUri);
        const res = await fetch(metaUrl, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const meta = await res.json() as Record<string, unknown>;
          if (!resolvedImage && typeof meta.image === "string" && meta.image) {
            resolvedImage = meta.image;
          }
          if (!resolvedDescription && typeof meta.description === "string" && meta.description) {
            resolvedDescription = meta.description;
          }
        }
      } catch { /* non-fatal — image/description remain null */ }
    }

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        standard: "ERC1155",
        metadataStatus: "FETCHED",
        image: resolvedImage ?? undefined,
        description: resolvedDescription ?? undefined,
      },
    });
    log.debug({ chain, contractAddress, resolvedImage }, "ERC1155_FACTORY collection metadata marked FETCHED");
    worker.enqueue({ type: "STATS_UPDATE", chain, contractAddress });
    return;
  }

  await prisma.collection.upsert({
    where: { chain_contractAddress: { chain, contractAddress } },
    create: { chain, contractAddress, metadataStatus: "FETCHING", startBlock: BigInt(0) },
    update: { metadataStatus: "FETCHING" },
  });

  try {
    const { name, symbol, baseUri } = await fetchCollectionOnChainInfo(contractAddress);

    // Look up description + image + owner from the most recent matching CREATE_COLLECTION intent
    const resolvedName = existing?.name ?? name;
    const { description, image, owner: intentOwner } = await findIntentMetadata(resolvedName);

    // Try to fetch on-chain owner() as fallback
    let onChainOwner: string | null = null;
    try {
      const provider = createProvider();
      const ownerContract = new Contract(OWNER_ABI as any, contractAddress, provider);
      const raw = await (ownerContract as any).owner();
      if (raw) onChainOwner = normalizeAddress(raw.toString());
    } catch { /* contract may not expose owner() */ }

    const standard = await detectTokenStandard(contractAddress);

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        // Preserve admin-set values — only fill in if not already set
        name: existing?.name ?? (name || null),
        symbol: existing?.symbol ?? (symbol || null),
        baseUri: baseUri || null,
        description: description ?? undefined,
        image: existing?.image ?? image ?? undefined,
        owner: existing?.owner ?? intentOwner ?? onChainOwner ?? undefined,
        standard,
        metadataStatus: "FETCHED",
      },
    });

    log.debug(
      { chain, contractAddress, name, symbol, baseUri, description },
      "Collection on-chain metadata fetched"
    );

    // Always run a stats update after metadata fetch so totalSupply, holderCount,
    // and image/description backfill from tokens are applied immediately.
    worker.enqueue({ type: "STATS_UPDATE", chain, contractAddress });
  } catch (err) {
    log.error({ err, chain, contractAddress }, "Collection metadata fetch failed");
    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain, contractAddress } },
      create: { chain, contractAddress, metadataStatus: "FAILED", startBlock: BigInt(0) },
      update: { metadataStatus: "FAILED" },
    });
    throw err;
  }
}

/**
 * Detect whether a contract is ERC-721 or ERC-1155 via ERC-165 supportsInterface().
 * Falls back to UNKNOWN if the contract doesn't expose the function.
 */
async function detectTokenStandard(contractAddress: string): Promise<TokenStandard> {
  const provider = createProvider();
  const contract = new Contract(SUPPORTS_INTERFACE_ABI as any, contractAddress, provider);

  for (const fn of ["supports_interface", "supportsInterface"]) {
    try {
      const is1155 = await (contract as any)[fn](INTERFACE_ID_ERC1155);
      if (is1155 === true || is1155 === 1n || String(is1155) === "1") return "ERC1155";
      const is721 = await (contract as any)[fn](INTERFACE_ID_ERC721);
      if (is721 === true || is721 === 1n || String(is721) === "1") return "ERC721";
      // Contract responded but supports neither — stop trying
      return "UNKNOWN";
    } catch {
      // Try the other function name variant
    }
  }

  return "UNKNOWN";
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
