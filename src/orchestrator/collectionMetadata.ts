import { Contract, shortString } from "starknet";
import { type Chain, type Prisma, type TokenStandard } from "@prisma/client";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { worker } from "./worker.js";
import { ipfsToHttp } from "../utils/ipfs.js";
import { IPFS_GATEWAYS } from "../config/constants.js";
import { isPrivateOrInsecureUrl, resolvesToPrivateHost } from "../utils/ssrf.js";
import { readTextCapped } from "../utils/httpBody.js";

const log = createLogger("orchestrator:collection-metadata");

const MAX_METADATA_BYTES = 512 * 1024;

const INTERFACE_ID_SRC5_ERC721  = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16d3d20a2a";
const INTERFACE_ID_SRC5_ERC1155 = "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52";

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

export async function handleCollectionMetadataFetch(payload: {
  chain: string;
  contractAddress: string;
}): Promise<void> {
  const { contractAddress } = payload;
  const chain = payload.chain as Chain;

  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { metadataStatus: true, name: true, symbol: true, owner: true, image: true, service: true, standard: true, baseUri: true, description: true },
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

      try {
        const rawOwner = await callRpc((provider) => {
          const ownerContract = new Contract({ abi: OWNER_ABI as any, address: contractAddress, providerOrAccount: provider });
          return (ownerContract as any).owner();
        });
        if (rawOwner) onchainOwner = normalizeAddress("STARKNET", rawOwner.toString());
      } catch {

      }
    }

    const canonicalBaseUri = existing?.baseUri || onchainBaseUri || "";

    let resolvedImage: string | null = existing.image ?? null;
    let resolvedDescription: string | null = existing.description ?? null;
    if (canonicalBaseUri && (!resolvedImage || !resolvedDescription)) {
      const fetched = await fetchCollectionMetadataJson(canonicalBaseUri);
      resolvedImage = resolvedImage ?? fetched.image;
      resolvedDescription = resolvedDescription ?? fetched.description;
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
    const { name, symbol, baseUri } = await fetchCollectionOnChainInfo(contractAddress, !isOwnCollection);

    if (isOwnCollection && !name && !symbol && !existing?.name && !existing?.symbol) {
      throw new Error("On-chain name/symbol read failed for own collection — no legacy fallback available");
    }

    const collectionMetadata = await fetchCollectionMetadataJson(baseUri);

    const resolvedName = name || existing?.name || "";
    const { description, image, owner: intentOwner } = await findIntentMetadata(resolvedName);

    let onChainOwner: string | null = null;
    try {
      const raw = await callRpc((provider) => {
        const ownerContract = new Contract({ abi: OWNER_ABI as any, address: contractAddress, providerOrAccount: provider });
        return (ownerContract as any).owner();
      });
      if (raw) onChainOwner = normalizeAddress("STARKNET", raw.toString());
    } catch {  }

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

    worker.enqueue({ type: "STATS_UPDATE", chain, contractAddress });
  } catch (err) {
    log.error({ err, chain, contractAddress }, "Collection metadata fetch failed");

    await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress } },
      data: { metadataStatus: "FAILED" },
    });
    throw err;
  }
}

export async function fetchCollectionMetadataJson(
  baseUri: string
): Promise<{ description: string | null; image: string | null }> {
  if (!baseUri) return { description: null, image: null };

  const isDirectory = baseUri.endsWith("/");
  const cid = baseUri.startsWith("ipfs://") ? baseUri.slice(7) : null;
  const bareCid = cid?.replace(/\/+$/, "") ?? null;
  const directoryUrls = cid
    ? IPFS_GATEWAYS.map((gateway) => `${gateway}/${cid}${isDirectory ? "collection.json" : ""}`)
    : [isDirectory ? `${ipfsToHttp(baseUri)}collection.json` : ipfsToHttp(baseUri)];
  const bareFallbackUrls = isDirectory && bareCid
    ? IPFS_GATEWAYS.map((gateway) => `${gateway}/${bareCid}`)
    : [];
  const urls = [...directoryUrls, ...bareFallbackUrls];

  for (const url of urls) {
    if (!url) continue;

    if (isPrivateOrInsecureUrl(url, false)) {
      log.warn({ url }, "Blocked SSRF attempt in collection metadata fetch");
      continue;
    }

    const hostname = new URL(url).hostname;
    if (await resolvesToPrivateHost(hostname)) {
      log.warn({ url, hostname }, "Blocked SSRF attempt — hostname resolves to a private address");
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      if (res.status >= 300 && res.status < 400) continue;
      if (!res.ok) continue;
      const { text, truncated } = await readTextCapped(res, MAX_METADATA_BYTES);
      if (truncated) {
        log.warn({ url, maxBytes: MAX_METADATA_BYTES }, "Collection metadata body exceeded size cap — rejecting");
        continue;
      }
      const meta = JSON.parse(text) as Record<string, unknown>;
      return {
        description: typeof meta.description === "string" && meta.description ? meta.description : null,
        image: typeof meta.image === "string" && meta.image ? meta.image : null,
      };
    } catch {

    }
  }

  return { description: null, image: null };
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

export async function detectTokenStandard(contractAddress: string): Promise<TokenStandard | null> {
  for (const fn of ["supports_interface", "supportsInterface"]) {
    try {
      for (const id of ERC1155_PROBE_IDS) {
        const result = await callRpc((provider) => {
          const contract = new Contract({ abi: SUPPORTS_INTERFACE_ABI as any, address: contractAddress, providerOrAccount: provider });
          return (contract as any)[fn](id);
        });
        if (result === true || result === 1n || String(result) === "1") return "ERC1155";
      }
      for (const id of ERC721_PROBE_IDS) {
        const result = await callRpc((provider) => {
          const contract = new Contract({ abi: SUPPORTS_INTERFACE_ABI as any, address: contractAddress, providerOrAccount: provider });
          return (contract as any)[fn](id);
        });
        if (result === true || result === 1n || String(result) === "1") return "ERC721";
      }
      return null;
    } catch {

    }
  }

  return null;
}

function isOwnService(service: string | null | undefined): boolean {
  return service != null && !service.startsWith("external-");
}

async function fetchCollectionOnChainInfo(
  contractAddress: string,
  allowLegacyFallback: boolean
): Promise<{ name: string; symbol: string; baseUri: string }> {

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

  }

  if (!allowLegacyFallback) {

    return { name: "", symbol: "", baseUri: "" };
  }

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

  }

  return { name: "", symbol: "", baseUri: "" };
}

async function callView(contractAddress: string, fn: string): Promise<unknown> {
  try {
    return await callRpc((provider) => {
      const contract = new Contract({ abi: ERC721_INFO_ABI_FELT as any, address: contractAddress, providerOrAccount: provider });
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

      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch {

        return shortString.decodeShortString(raw.toString());
      }
    } catch {
      return raw.toString();
    }
  }
  return "";
}

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
