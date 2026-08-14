

import { cairo, Contract, CairoOption, CairoOptionVariant } from "starknet";
import { callRpc, normalizeAddress, createProvider } from "../../utils/starknet.js";
import {
  STARKNET_COLLECTION_1155_CONTRACT, STARKNET_IP_TICKETS_FACTORY_CONTRACT, STARKNET_IP_CLUB_FACTORY_CONTRACT,
  STARKNET_POP_FACTORY_CONTRACT, STARKNET_DROP_FACTORY_CONTRACT,
} from "../../config/constants.js";
import {
  IPCollection1155FactoryABI,
  IPCollection1155ABI,
  IPTicketCollectionFactoryABI,
  IPTicketCollectionABI,
  IPClubFactoryABI,
  IPClubCollectionABI,
  POPFactoryABI,
  DropFactoryABI,
  toDropContractConditions,
} from "@medialane/sdk/starknet";
import type { PopEventType } from "@medialane/sdk";
import type { MintIntentBody, CreateCollectionIntentBody, CreateTierIntentBody } from "../../types/api.js";
import prisma from "../../db/client.js";
import { uploadJson } from "../metadataPin.js";
import { resolveServiceForContract } from "../../utils/collection.js";
import { log, encodeByteArray, resolveCollectionContract } from "./shared.js";

export const FACTORY_FAMILY_SERVICE_IDS = ["mip-erc1155", "ip-tickets", "ip-club"] as const;
export const TIER_SERVICE_IDS = ["ip-tickets", "ip-club"] as const;
type FactoryFamilyServiceId = typeof FACTORY_FAMILY_SERVICE_IDS[number];

export const COLLECTION_SERVICE_IDS = [...FACTORY_FAMILY_SERVICE_IDS, "pop-protocol", "drop-collection"] as const;

const FACTORY_FAMILY_SERVICES: Record<FactoryFamilyServiceId, { factoryAddress: string; factoryAbi: unknown; collectionAbi: unknown }> = {
  "mip-erc1155": {
    factoryAddress: STARKNET_COLLECTION_1155_CONTRACT,
    factoryAbi: IPCollection1155FactoryABI,
    collectionAbi: IPCollection1155ABI,
  },
  "ip-tickets": {
    factoryAddress: STARKNET_IP_TICKETS_FACTORY_CONTRACT,
    factoryAbi: IPTicketCollectionFactoryABI,
    collectionAbi: IPTicketCollectionABI,
  },
  "ip-club": {
    factoryAddress: STARKNET_IP_CLUB_FACTORY_CONTRACT,
    factoryAbi: IPClubFactoryABI,
    collectionAbi: IPClubCollectionABI,
  },
};

function isFactoryFamilyService(service: string | null): service is FactoryFamilyServiceId {
  return service != null && Object.prototype.hasOwnProperty.call(FACTORY_FAMILY_SERVICES, service);
}

async function assertFactoryCollectionOwner(collectionAddress: string, expectedOwner: string): Promise<void> {
  const result = await callRpc((provider) => provider.callContract({
    contractAddress: collectionAddress,
    entrypoint: "owner",
    calldata: [],
  }));
  const onChainOwner = normalizeAddress("STARKNET", result[0]);
  if (onChainOwner !== expectedOwner) {
    throw new Error(`Address ${expectedOwner} is not the owner of collection ${collectionAddress}`);
  }
}

const REGISTRY_COMPATIBLE_SERVICES = new Set(["mip-erc721", "ip-erc721"]);

export async function buildMintIntent(body: MintIntentBody) {
  const owner = normalizeAddress("STARKNET", body.owner);
  const recipient = normalizeAddress("STARKNET", body.recipient);
  const contractAddress = resolveCollectionContract(body.collectionContract);
  const service = body.collectionContract
    ? await resolveServiceForContract(prisma, "STARKNET", contractAddress)
    : "mip-erc721";

  if (isFactoryFamilyService(service)) {
    const family = FACTORY_FAMILY_SERVICES[service];
    if (body.royaltyBps) {
      throw new Error(
        `royaltyBps has no effect on a ${service} mint — set it via ${service === "mip-erc1155" ? "setDefaultRoyalty/setTokenRoyalty" : "CREATE_TIER"} instead.`,
      );
    }
    await assertFactoryCollectionOwner(contractAddress, owner);
    const collection = new Contract({ abi: family.collectionAbi as never, address: contractAddress, providerOrAccount: createProvider() as never });

    if (service === "mip-erc1155") {
      if (!body.tokenUri || !body.value) {
        throw new Error("tokenUri and value are required to mint a new mip-erc1155 edition");
      }
      const call = collection.populate("mint_edition", [recipient, cairo.uint256(body.value), body.tokenUri]);
      return { calls: [call] };
    }

    if (!body.tokenId || !body.amount) {
      throw new Error(`tokenId and amount are required to mint on ${service} — create the tier first via CREATE_TIER`);
    }
    const call = collection.populate("mint", [recipient, cairo.uint256(body.tokenId), cairo.uint256(body.amount)]);
    return { calls: [call] };
  }

  if (service && !REGISTRY_COMPATIBLE_SERVICES.has(service)) {
    throw new Error(
      `Service "${service}" does not support the intents-based mint flow. Supported: mip-erc721, ip-erc721, ${FACTORY_FAMILY_SERVICE_IDS.join(", ")}.`,
    );
  }

  if (!body.collectionId || !body.tokenUri) {
    throw new Error("collectionId and tokenUri are required for a registry mint");
  }
  const id = cairo.uint256(body.collectionId);

  const ownershipResult = await callRpc((provider) => provider.callContract({
    contractAddress,
    entrypoint: "is_collection_owner",
    calldata: [id.low.toString(), id.high.toString(), owner],
  }));
  if (!ownershipResult[0] || BigInt(ownershipResult[0]) === 0n) {
    throw new Error(`Address ${body.owner} is not the owner of collection ${body.collectionId}`);
  }

  const calldata = [
    id.low.toString(),
    id.high.toString(),
    recipient,
    ...encodeByteArray(body.tokenUri),
    (body.royaltyBps ?? 0).toString(),
  ];
  return { calls: [{ contractAddress, entrypoint: "mint", calldata }] };
}

export async function buildCreateCollectionIntent(body: CreateCollectionIntentBody) {
  let baseUri = body.baseUri || "";

  if (!baseUri) {
    try {

      const metadata: Record<string, unknown> = { name: body.name };
      if (body.description) metadata.description = body.description;
      if (body.image) metadata.image = body.image;
      metadata.external_link = "https://medialane.io";

      baseUri = await uploadJson(metadata);
      log.info({ name: body.name, baseUri }, "Collection metadata uploaded to IPFS");
    } catch (err) {
      log.warn({ err }, "Failed to upload collection metadata to IPFS — proceeding with empty base_uri");
    }
  }

  if (isFactoryFamilyService(body.service ?? null)) {
    const family = FACTORY_FAMILY_SERVICES[body.service as FactoryFamilyServiceId];
    const factory = new Contract({ abi: family.factoryAbi as never, address: family.factoryAddress, providerOrAccount: createProvider() as never });
    const call = factory.populate("deploy_collection", [body.name, body.symbol, baseUri]);
    return { calls: [call] };
  }

  if (body.service === "pop-protocol") {
    if (body.claimEndTimestamp == null || !body.eventType) {
      throw new Error("claimEndTimestamp and eventType are required to deploy a pop-protocol collection");
    }
    const factory = new Contract({ abi: POPFactoryABI as never, address: STARKNET_POP_FACTORY_CONTRACT, providerOrAccount: createProvider() as never });
    const call = factory.populate("create_collection", [
      body.name,
      body.symbol,
      baseUri,
      body.claimEndTimestamp,
      { [body.eventType as PopEventType]: {} },
    ]);
    return { calls: [call] };
  }

  if (body.service === "drop-collection") {
    if (!body.maxSupply || !body.conditions) {
      throw new Error("maxSupply and conditions are required to deploy a drop-collection");
    }
    const factory = new Contract({ abi: DropFactoryABI as never, address: STARKNET_DROP_FACTORY_CONTRACT, providerOrAccount: createProvider() as never });

    const call = factory.populate("create_drop", [
      body.name,
      body.symbol,
      baseUri,
      BigInt(body.maxSupply),
      toDropContractConditions(body.conditions),
    ]);
    return { calls: [call] };
  }

  const contract = resolveCollectionContract(body.collectionContract);
  const calldata = [
    ...encodeByteArray(body.name),
    ...encodeByteArray(body.symbol),
    ...encodeByteArray(baseUri),
  ];
  return { calls: [{ contractAddress: contract, entrypoint: "create_collection", calldata }] };
}

export async function buildCreateTierIntent(body: CreateTierIntentBody) {
  if (body.service !== "ip-tickets" && body.service !== "ip-club") {
    throw new Error(`CREATE_TIER is only supported for ip-tickets and ip-club, got "${body.service}"`);
  }
  const family = FACTORY_FAMILY_SERVICES[body.service];

  const collectionAddress = normalizeAddress("STARKNET", body.collection);
  const owner = normalizeAddress("STARKNET", body.owner);
  await assertFactoryCollectionOwner(collectionAddress, owner);

  const collection = new Contract({ abi: family.collectionAbi as never, address: collectionAddress, providerOrAccount: createProvider() as never });

  const startTime = body.startTime != null
    ? new CairoOption(CairoOptionVariant.Some, body.startTime)
    : new CairoOption(CairoOptionVariant.None);
  const endTime = body.endTime != null
    ? new CairoOption(CairoOptionVariant.Some, body.endTime)
    : new CairoOption(CairoOptionVariant.None);

  const entrypoint = body.service === "ip-tickets" ? "create_ticket" : "create_membership";
  const call = collection.populate(entrypoint, [
    cairo.uint256(body.maxSupply),
    startTime,
    endTime,
    body.royaltyBps,
    body.metadataUri,
  ]);
  return { calls: [call] };
}
