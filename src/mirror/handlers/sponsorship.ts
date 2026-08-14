import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import {
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  OFFER_CREATED_SELECTOR,
  OFFER_STATUS_UPDATED_SELECTOR,
  BID_PLACED_SELECTOR,
  BID_RETRACTED_SELECTOR,
  SPONSORSHIP_ACCEPTED_SELECTOR,
  PROPOSAL_CREATED_SELECTOR,
  PROPOSAL_CLOSED_SELECTOR,
  PROPOSAL_ACCEPTED_SELECTOR,
  LICENSE_MINTED_SELECTOR,
} from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";
import type { SourceContext } from "../sources.js";

const log = createLogger("mirror:sponsorship");

const IP_SPONSORSHIP_START_BLOCK = 11896456n;

export class FeltCursor {
  private i = 0;
  constructor(private readonly felts: string[]) {}

  private next(): bigint {
    return BigInt(this.felts[this.i++] ?? "0x0");
  }

  u64(): number {
    return Number(this.next());
  }

  u256(): string {
    const low = this.next();
    const high = this.next();
    return ((high << 128n) | low).toString();
  }

  address(): string {
    return normalizeAddress("STARKNET", num.toHex(this.next()));
  }

  bool(): boolean {
    return this.next() !== 0n;
  }

  optionAddress(): string | null {
    const variant = this.next();
    return variant === 0n ? this.address() : null;
  }

  byteArray(): string {
    const dataLen = Number(this.next());
    const words: bigint[] = [];
    for (let i = 0; i < dataLen; i++) words.push(this.next());
    const pendingWord = this.next();
    const pendingWordLen = Number(this.next());

    const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
    let byteOffset = 0;
    for (const word of words) {
      for (let j = 0; j < 31; j++) {
        bytes[byteOffset++] = Number((word >> BigInt((30 - j) * 8)) & 0xffn);
      }
    }
    for (let j = 0; j < pendingWordLen; j++) {
      bytes[byteOffset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

const unixToDate = (seconds: number): Date => new Date(seconds * 1000);
const keyCursor = (event: RawStarknetEvent) => new FeltCursor(event.keys.slice(1).map((k) => num.toHex(k)));
const dataCursor = (event: RawStarknetEvent) => new FeltCursor((event.data ?? []).map((d) => num.toHex(d)));
const selectorOf = (event: RawStarknetEvent): string => num.toHex(event.keys[0] ?? "0x0");

async function handleOfferCreated(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const offerId = keys.u256();
  const author = keys.address();
  const nftContract = keys.address();

  const data = dataCursor(event);
  const tokenId = data.u256();
  const minAmount = data.u256();
  const duration = data.u64();
  const paymentToken = data.address();
  const licenseTermsUri = data.byteArray();
  const transferable = data.bool();
  const royaltyBps = Number(data.u256());
  const specificSponsor = data.optionAddress();
  const createdAt = data.u64();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  await prisma.sponsorshipOffer.upsert({
    where: { chain_contractAddress_offerId: { chain: "STARKNET", contractAddress, offerId } },
    create: {
      chain: "STARKNET", contractAddress, offerId, author, nftContract, tokenId, minAmount, duration,
      paymentToken, licenseTermsUri, transferable, royaltyBps, specificSponsor, open: true,
      createdAtChain: unixToDate(createdAt),
    },
    update: {},
  });
}

async function handleOfferStatusUpdated(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const offerId = keys.u256();
  const data = dataCursor(event);
  const open = data.bool();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);
  await prisma.sponsorshipOffer.updateMany({
    where: { chain: "STARKNET", contractAddress, offerId },
    data: { open },
  });
}

async function handleBidPlaced(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const offerId = keys.u256();
  const sponsor = keys.address();
  const data = dataCursor(event);
  const amount = data.u256();
  const bidAt = data.u64();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  const offer = await prisma.sponsorshipOffer.findUnique({
    where: { chain_contractAddress_offerId: { chain: "STARKNET", contractAddress, offerId } },
    select: { id: true },
  });
  if (!offer) {
    log.warn({ contractAddress, offerId }, "BidPlaced for unknown offer, skipping");
    return;
  }

  await prisma.sponsorshipBid.upsert({
    where: { chain_contractAddress_offerId_sponsor: { chain: "STARKNET", contractAddress, offerId, sponsor } },
    create: { chain: "STARKNET", contractAddress, offerId, sponsor, amount, placedAtChain: unixToDate(bidAt) },
    update: { amount, placedAtChain: unixToDate(bidAt) },
  });
}

async function handleBidRetracted(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const offerId = keys.u256();
  const sponsor = keys.address();
  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  await prisma.sponsorshipBid.deleteMany({
    where: { chain: "STARKNET", contractAddress, offerId, sponsor },
  });
}

async function handleSponsorshipAccepted(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const offerId = keys.u256();
  keys.u256();
  const sponsor = keys.address();
  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  await prisma.sponsorshipOffer.updateMany({
    where: { chain: "STARKNET", contractAddress, offerId },
    data: { open: false },
  });
  await prisma.sponsorshipBid.deleteMany({
    where: { chain: "STARKNET", contractAddress, offerId, sponsor },
  });
}

async function handleProposalCreated(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const proposalId = keys.u256();
  const proposer = keys.address();
  const nftContract = keys.address();

  const data = dataCursor(event);
  const tokenId = data.u256();
  const amount = data.u256();
  const duration = data.u64();
  const validUntil = data.u64();
  const paymentToken = data.address();
  const licenseTermsUri = data.byteArray();
  const transferable = data.bool();
  const royaltyBps = Number(data.u256());
  const createdAt = data.u64();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  await prisma.sponsorshipProposal.upsert({
    where: { chain_contractAddress_proposalId: { chain: "STARKNET", contractAddress, proposalId } },
    create: {
      chain: "STARKNET", contractAddress, proposalId, proposer, nftContract, tokenId, amount, duration,
      validUntil: validUntil > 0 ? unixToDate(validUntil) : null, paymentToken, licenseTermsUri,
      transferable, royaltyBps, open: true, createdAtChain: unixToDate(createdAt),
    },
    update: {},
  });
}

async function handleProposalClosed(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const proposalId = keys.u256();
  const data = dataCursor(event);
  const accepted = data.bool();
  const closedAt = data.u64();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);
  await prisma.sponsorshipProposal.updateMany({
    where: { chain: "STARKNET", contractAddress, proposalId },
    data: { open: false, accepted, closedAtChain: unixToDate(closedAt) },
  });
}

async function handleLicenseMinted(event: RawStarknetEvent): Promise<void> {
  const keys = keyCursor(event);
  const tokenId = keys.u256();
  const recipient = keys.address();
  const author = keys.address();

  const data = dataCursor(event);
  const assetContract = data.address();
  const assetTokenId = data.u256();
  const expiresAt = data.u64();
  const transferable = data.bool();
  const royaltyBps = Number(data.u256());
  const licenseTermsUri = data.byteArray();
  const mintedAt = data.u64();

  const contractAddress = normalizeAddress("STARKNET", event.from_address);
  const provenance = provenanceByLicenseId.get(tokenId) ?? {};

  await prisma.sponsorshipLicense.upsert({
    where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
    create: {
      chain: "STARKNET", contractAddress, tokenId, author, recipient, assetContract, assetTokenId,
      expiresAt: unixToDate(expiresAt), transferable, royaltyBps, licenseTermsUri,
      offerId: provenance.offerId ?? null, proposalId: provenance.proposalId ?? null,
      mintedAtChain: unixToDate(mintedAt),
    },
    update: {},
  });
}

const provenanceByLicenseId = new Map<string, { offerId?: string; proposalId?: string }>();

export async function applySponsorship(events: RawStarknetEvent[], ctx: SourceContext): Promise<void> {
  if (events.length === 0) return;
  provenanceByLicenseId.clear();

  const contractAddress = normalizeAddress("STARKNET", STARKNET_IP_SPONSORSHIP_CONTRACT);

  await upsertCollectionFromFactory(prisma, {
    chain: "STARKNET",
    contractAddress,
    service: "ip-sponsorship",
    standard: "ERC721",
    startBlock: IP_SPONSORSHIP_START_BLOCK,
  });
  ctx.affectedContracts.add(contractAddress);

  for (const event of events) {
    const selector = selectorOf(event);
    if (selector === num.toHex(SPONSORSHIP_ACCEPTED_SELECTOR)) {
      const keys = keyCursor(event);
      const offerId = keys.u256();
      const licenseId = keys.u256();
      provenanceByLicenseId.set(licenseId, { offerId });
    } else if (selector === num.toHex(PROPOSAL_ACCEPTED_SELECTOR)) {
      const keys = keyCursor(event);
      const proposalId = keys.u256();
      const licenseId = keys.u256();
      provenanceByLicenseId.set(licenseId, { proposalId });
    }
  }

  for (const event of events) {
    const txHash = event.transaction_hash ?? "";
    try {
      const selector = selectorOf(event);
      if (selector === num.toHex(OFFER_CREATED_SELECTOR)) await handleOfferCreated(event);
      else if (selector === num.toHex(OFFER_STATUS_UPDATED_SELECTOR)) await handleOfferStatusUpdated(event);
      else if (selector === num.toHex(BID_PLACED_SELECTOR)) await handleBidPlaced(event);
      else if (selector === num.toHex(BID_RETRACTED_SELECTOR)) await handleBidRetracted(event);
      else if (selector === num.toHex(SPONSORSHIP_ACCEPTED_SELECTOR)) await handleSponsorshipAccepted(event);
      else if (selector === num.toHex(PROPOSAL_CREATED_SELECTOR)) await handleProposalCreated(event);
      else if (selector === num.toHex(PROPOSAL_CLOSED_SELECTOR)) await handleProposalClosed(event);

      else if (selector === num.toHex(LICENSE_MINTED_SELECTOR)) await handleLicenseMinted(event);
    } catch (err) {
      log.error({ err, txHash }, "sponsorship event handler failed");
    }
  }
}
