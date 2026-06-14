import { Contract, shortString } from "starknet";
import { type Chain, type Prisma, type TokenStandard } from "@prisma/client";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { worker } from "./worker.js";
import { ipfsToHttp } from "../utils/ipfs.js";
import { IPFS_GATEWAYS } from "../config/constants.js";
import { isPrivateOrInsecureUrl } from "../utils/ssrf.js";

const log = createLogger("orchestrator:collection-metadata");

// Starknet SRC5 interface IDs (OpenZeppelin Cairo)
// Computed as XOR of sn_keccak(fn_selector) for each function in the interface.
// These differ from EVM ERC-165 IDs — Starknet OZ contracts reject EVM IDs.
const INTERFACE_ID_SRC5_ERC721  = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16d3d20a2a";
const INTERFACE_ID_SRC5_ERC1155 = "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52";

// EVM ERC-165 IDs — kept as fallback for bridged/EVM-compatible contracts
const INTERFACE_ID_ERC165_ERC721  = "0x80ac58cd";
const INTERFACE_ID_ERC165_ERC1155 = "0xd9b67a26";

const ERC1155_PROBE_IDS = [INTERFACE_ID_SRC5_ERC1155, INTERFACE_ID_ERC165_ERC1155];
const ERC721_PROBE_IDS  = [INTERFACE_ID_SRC5_ERC721, INTERFACE_ID_ERC165_ERC721];

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
    select: { metadataStatus: true, name: true, symbol: true, owner: true, image: true, service: true, standard: true, baseUri: true, description: true },
  });

  // Skip if already fully resolved. Re-run if image is missing for event-sourced
  // collections that should have one resolved from baseUri metadata.
  const alreadyComplete =
    existing?.metadataStatus === "FETCHED" &&
    existing?.owner !== null &&
    (existing?.service !== "mip-erc1155" || existing?.image !== null) &&
    (existing?.service !== "mip-erc721" || existing?.image !== null);

  if (alreadyComplete) {
    log.debug({ chain, contractAddress }, "Collection metadata already fetched, skipping");
    return;
  }

  // Creator Coins (ERC-20, service "creator-coin"): name/symbol come from the
  // CreatorCoinCreated event (set by the factory handler). There is no
  // token_uri/base_uri to resolve, so just mark FETCHED. Price/liquidity is read
  // from the coin's Ekubo pool elsewhere, never here.
  if (existing?.service === "creator-coin" || existing?.standard === "ERC20") {
    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: { metadataStatus: "FETCHED", standard: "ERC20" },
    });
    log.debug({ chain, contractAddress }, "Creator Coin (ERC20) collection marked FETCHED");
    return;
  }

  // ERC1155 collections (Medialane-deployed or external): name, symbol, and base_uri
  // are decoded by the indexer for mip-erc1155, and read on-chain for externals.
  // detectTokenStandard() uses EVM ERC-165 IDs that don't match Starknet OZ SRC5
  // interface IDs (always returns UNKNOWN), so this branch handles ERC1155 fetch
  // explicitly. `service` is intentionally NOT written here — it is owned by the
  // indexer factory handlers (mip-erc1155) or stays null (external).
  if (existing?.service === "mip-erc1155" || existing?.standard === "ERC1155") {
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
      const onchainInfo = await fetchCollectionOnChainInfo(contractAddress);
      onchainName = onchainInfo.name;
      onchainSymbol = onchainInfo.symbol;
      onchainBaseUri = onchainInfo.baseUri;

      try {
        const rawOwner = await callRpc((provider) => {
          const ownerContract = new Contract(OWNER_ABI as any, contractAddress, provider);
          return (ownerContract as any).owner();
        });
        if (rawOwner) onchainOwner = normalizeAddress("STARKNET", rawOwner.toString());
      } catch {
        // Some ERC1155 deployments may omit owner(); keep the existing value.
      }
    }

    const canonicalBaseUri = existing?.baseUri || onchainBaseUri || "";

    // Resolve image + description from the base_uri JSON if not already set.
    // base_uri points to an IPFS collection metadata JSON (OpenSea format):
    // { name, description, image, external_link }
    let resolvedImage: string | null = existing.image ?? null;
    let resolvedDescription: string | null = existing.description ?? null;
    if (canonicalBaseUri && (!resolvedImage || !resolvedDescription)) {
      // Try each IPFS gateway in order — the private Pinata gateway can block
      // server-side requests, so fall through to public gateways as needed.
      const cid = canonicalBaseUri.startsWith("ipfs://") ? canonicalBaseUri.slice(7) : null;
      if (cid) {
        for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
          try {
            const metaUrl = `${IPFS_GATEWAYS[i]}/${cid}`;
            const res = await fetch(metaUrl, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) continue;
            const meta = await res.json() as Record<string, unknown>;
            if (!resolvedImage && typeof meta.image === "string" && meta.image) {
              resolvedImage = meta.image;
            }
            if (!resolvedDescription && typeof meta.description === "string" && meta.description) {
              resolvedDescription = meta.description;
            }
            break; // success — stop trying gateways
          } catch { /* try next gateway */ }
        }
      }
    }

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: {
        standard: "ERC1155",
        metadataStatus: "FETCHED",
        name: existing?.name || onchainName || undefined,
        symbol: existing?.symbol || onchainSymbol || undefined,
        baseUri: canonicalBaseUri || undefined,
        owner: existing?.owner || onchainOwner || undefined,
        image: resolvedImage ?? undefined,
        description: resolvedDescription ?? undefined,
      },
    });
    log.debug({ chain, contractAddress, resolvedImage }, "ERC1155 collection metadata marked FETCHED");
    worker.enqueue({ type: "STATS_UPDATE", chain, contractAddress });
    return;
  }

  // Only update if the row already exists. Collection rows are created
  // by indexer handlers (factory CollectionCreated / Transfer events) —
  // never by the metadata orchestrator. If the row is missing, that's a
  // queue bug, not a recovery scenario.
  if (!existing) {
    log.warn({ chain, contractAddress }, "Metadata fetch queued for unknown collection — skipping");
    return;
  }
  await prisma.collection.update({
    where: { chain_contractAddress: { chain, contractAddress } },
    data: { metadataStatus: "FETCHING" },
  });

  try {
    const { name, symbol, baseUri } = await fetchCollectionOnChainInfo(contractAddress);
    const collectionMetadata = await fetchCollectionMetadataJson(baseUri);

    // Look up description + image + owner from the most recent matching CREATE_COLLECTION intent
    const resolvedName = name || existing?.name || "";
    const { description, image, owner: intentOwner } = await findIntentMetadata(resolvedName);

    // Try to fetch on-chain owner() as fallback
    let onChainOwner: string | null = null;
    try {
      const raw = await callRpc((provider) => {
        const ownerContract = new Contract(OWNER_ABI as any, contractAddress, provider);
        return (ownerContract as any).owner();
      });
      if (raw) onChainOwner = normalizeAddress("STARKNET", raw.toString());
    } catch { /* contract may not expose owner() */ }

    // Re-detect standard only if it could change. detectTokenStandard returns
    // null when SRC5 doesn't respond — in that case, keep the existing
    // standard (set by the indexer factory / transfer handler when the row
    // was first created).
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
        description: collectionMetadata.description ?? description ?? undefined,
        image: collectionMetadata.image ?? existing?.image ?? image ?? undefined,
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
    // Row was guaranteed to exist above; update-only here too.
    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: { metadataStatus: "FAILED" },
    });
    throw err;
  }
}

async function fetchCollectionMetadataJson(
  baseUri: string
): Promise<{ description: string | null; image: string | null }> {
  if (!baseUri) return { description: null, image: null };

  const cid = baseUri.startsWith("ipfs://") ? baseUri.slice(7) : null;
  const urls = cid ? IPFS_GATEWAYS.map((gateway) => `${gateway}/${cid}`) : [ipfsToHttp(baseUri)];

  for (const url of urls) {
    if (!url) continue;
    if (isPrivateOrInsecureUrl(url, false)) {
      log.warn({ url }, "Blocked SSRF attempt in collection metadata fetch");
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      if (res.status >= 300 && res.status < 400) continue;
      if (!res.ok) continue;
      const meta = await res.json() as Record<string, unknown>;
      return {
        description: typeof meta.description === "string" && meta.description ? meta.description : null,
        image: typeof meta.image === "string" && meta.image ? meta.image : null,
      };
    } catch {
      // Try next gateway.
    }
  }

  return { description: null, image: null };
}

/**
 * Apply service-based override when on-chain detection is ambiguous.
 * pop-protocol and drop-collection are always ERC-721 by protocol design,
 * as is the Medialane ERC-721 registry (mip-erc721).
 */
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

/**
 * Detect whether a contract is ERC-721 or ERC-1155 via SRC5 supportsInterface().
 * Tries Starknet OZ SRC5 IDs first, then EVM ERC-165 IDs for bridged contracts.
 * Returns null when the contract doesn't expose supportsInterface or matches no
 * known ID — callers should refuse to create the row in that case rather than
 * inventing a fake standard.
 */
export async function detectTokenStandard(contractAddress: string): Promise<TokenStandard | null> {
  for (const fn of ["supports_interface", "supportsInterface"]) {
    try {
      for (const id of ERC1155_PROBE_IDS) {
        const result = await callRpc((provider) => {
          const contract = new Contract(SUPPORTS_INTERFACE_ABI as any, contractAddress, provider);
          return (contract as any)[fn](id);
        });
        if (result === true || result === 1n || String(result) === "1") return "ERC1155";
      }
      for (const id of ERC721_PROBE_IDS) {
        const result = await callRpc((provider) => {
          const contract = new Contract(SUPPORTS_INTERFACE_ABI as any, contractAddress, provider);
          return (contract as any)[fn](id);
        });
        if (result === true || result === 1n || String(result) === "1") return "ERC721";
      }
      return null;
    } catch {
      // Try the other function name variant
    }
  }

  return null;
}

async function fetchCollectionOnChainInfo(
  contractAddress: string
): Promise<{ name: string; symbol: string; baseUri: string }> {
  // Try ByteArray variant first using raw calls (UTF-8 safe — starknet.js ABI
  // decoding of ByteArray is ASCII-only and corrupts non-Latin characters).
  try {
    const [name, symbol, baseUri] = await Promise.all([
      callViewByteArrayUtf8(contractAddress, "name"),
      callViewByteArrayUtf8(contractAddress, "symbol"),
      callViewByteArrayUtf8(contractAddress, "base_uri"),
    ]);
    if (name || symbol) {
      return { name: name ?? "", symbol: symbol ?? "", baseUri: baseUri ?? "" };
    }
  } catch {
    // Fall through to felt252 ABI
  }

  // Felt252 fallback for older contracts
  try {
    const [nameRaw, symbolRaw, baseUriRaw] = await Promise.all([
      callView(contractAddress, "name"),
      callView(contractAddress, "symbol"),
      callView(contractAddress, "base_uri"),
    ]);
    const name = decodeField(nameRaw);
    const symbol = decodeField(symbolRaw);
    const baseUri = decodeField(baseUriRaw);
    if (name || symbol) {
      return { name, symbol, baseUri };
    }
  } catch {
    // ignore
  }

  return { name: "", symbol: "", baseUri: "" };
}

async function callView(contractAddress: string, fn: string): Promise<unknown> {
  try {
    return await callRpc((provider) => {
      const contract = new Contract(ERC721_INFO_ABI_FELT as any, contractAddress, provider);
      return (contract as any)[fn]();
    });
  } catch {
    return null;
  }
}

function decodeField(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "bigint") {
    try {
      const hex = raw.toString(16);
      const paddedHex = hex.length % 2 === 0 ? hex : "0" + hex;
      const bytes: number[] = [];
      for (let i = 0; i < paddedHex.length; i += 2) {
        const b = parseInt(paddedHex.slice(i, i + 2), 16);
        if (b !== 0) bytes.push(b);
      }
      // Try strict UTF-8 first — handles Portuguese, Chinese, emoji, etc.
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        // Bytes are not valid UTF-8 — fall back to ASCII short string decoding
        return shortString.decodeShortString(raw.toString());
      }
    } catch {
      return raw.toString();
    }
  }
  return "";
}

/**
 * Decode a Cairo ByteArray as UTF-8 using raw provider.callContract().
 * Bypasses starknet.js ABI decoding which is ASCII-only and corrupts
 * multi-byte characters (non-Latin scripts, emoji, etc.).
 */
async function callViewByteArrayUtf8(
  contractAddress: string,
  fn: string
): Promise<string | null> {
  try {
    const res = await callRpc((provider) => provider.callContract({
      contractAddress,
      entrypoint: fn,
      calldata: [],
    }));
    const felts: string[] = res as unknown as string[];
    if (!felts || felts.length < 3) return null;
    const dataLen = Number(BigInt(felts[0]));
    if (felts.length < 1 + dataLen + 2) return null;
    const pendingWord = BigInt(felts[1 + dataLen]);
    const pendingWordLen = Number(BigInt(felts[2 + dataLen]));
    const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
    let offset = 0;
    for (let i = 0; i < dataLen; i++) {
      const value = BigInt(felts[1 + i]);
      for (let j = 0; j < 31; j++) {
        bytes[offset++] = Number((value >> BigInt((30 - j) * 8)) & 0xffn);
      }
    }
    for (let j = 0; j < pendingWordLen; j++) {
      bytes[offset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
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
