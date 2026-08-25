import { getCoordinates, getTokenByAddress, normalizeAddress } from "@medialane/sdk";
import { resolveServiceForContract } from "../../utils/collection.js";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const EXTERNAL_SERVICES = new Set(["external-erc721", "external-erc1155"]);

// Entrypoints whose target is always one of a small, known set of registry
// contracts. Anything paymaster-eligible that isn't a per-creator collection
// (see PLATFORM_COLLECTION_ENTRYPOINTS) or a token/NFT approval
// (see TOKEN_OR_COLLECTION_ENTRYPOINTS) belongs here.
function fixedContractsFor(entrypoint: string): (string | undefined)[] | null {
  const coords = getCoordinates("STARKNET");
  switch (entrypoint) {
    case "register_order":
    case "fulfill_order":
    case "cancel_order":
      return [coords.marketplace721, coords.marketplace1155];
    case "create_creator_coin":
    case "launch_on_ekubo":
      return [coords.creatorCoinFactory];
    case "create_drop":
      return [coords.dropFactory];
    case "create_collection":
      return [coords.collection721];
    case "deploy_collection":
      return [coords.collection1155, coords.ipTicketsFactory, coords.ipClubFactory];
    case "create_offer":
    case "set_offer_open":
    case "place_bid":
    case "retract_bid":
    case "accept_bid":
    case "propose_sponsorship":
    case "withdraw_proposal":
    case "accept_proposal":
    case "reject_proposal":
      return [coords.ipSponsorship];
    default:
      return null;
  }
}

// Per-creator contracts the Medialane factories deployed — the indexer only
// ever writes a row here after replaying a real deploy event on-chain, so an
// attacker's own contract can never appear with a non-external service.
const PLATFORM_COLLECTION_ENTRYPOINTS = new Set(["mint", "mint_edition", "create_ticket", "create_membership"]);

// Targets a currency the platform recognizes, or any NFT collection the
// indexer knows about (including externally-minted ones — users can list any
// NFT they own on the marketplace, not just Medialane-minted ones).
const TOKEN_OR_COLLECTION_ENTRYPOINTS = new Set(["approve", "set_approval_for_all", "transfer"]);

// Exposed so paymaster.allowlist.test.ts can assert every entrypoint added to
// ALLOWED_PAYMASTER_ENTRYPOINTS also gets an address rule here — otherwise it
// silently falls through to "fail closed" (sponsorship quietly breaks) rather
// than a visible test failure telling whoever added it to classify it above.
export function hasAddressRule(entrypoint: string): boolean {
  return (
    fixedContractsFor(entrypoint) != null ||
    PLATFORM_COLLECTION_ENTRYPOINTS.has(entrypoint) ||
    TOKEN_OR_COLLECTION_ENTRYPOINTS.has(entrypoint)
  );
}

export interface ContractAddressChecker {
  isEligible(entrypoint: string, contractAddress: string): Promise<boolean>;
}

export function createContractAddressChecker(db: Db): ContractAddressChecker {
  return {
    async isEligible(entrypoint, contractAddress) {
      let normalized: string;
      try {
        normalized = normalizeAddress("STARKNET", contractAddress);
      } catch {
        return false;
      }

      const fixed = fixedContractsFor(entrypoint);
      if (fixed) {
        return fixed.some((addr) => addr != null && normalizeAddress("STARKNET", addr) === normalized);
      }

      if (PLATFORM_COLLECTION_ENTRYPOINTS.has(entrypoint)) {
        const service = await resolveServiceForContract(db, "STARKNET", normalized);
        return service != null && !EXTERNAL_SERVICES.has(service);
      }

      if (TOKEN_OR_COLLECTION_ENTRYPOINTS.has(entrypoint)) {
        if (getTokenByAddress(normalized)) return true;
        const service = await resolveServiceForContract(db, "STARKNET", normalized);
        return service != null;
      }

      return false;
    },
  };
}
