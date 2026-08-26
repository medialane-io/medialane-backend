import { getCoordinates, getTokenByAddress, normalizeAddress } from "@medialane/sdk";
import { resolveServiceForContract } from "../../utils/collection.js";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const EXTERNAL_SERVICES = new Set(["external-erc721", "external-erc1155"]);

// Every contract Medialane itself deployed and controls — the whole trust
// boundary for sponsored gas, independent of which allowed entrypoint is
// being called on it. Deliberately NOT every address in StarknetCoordinates:
// that object also holds class hashes (not addresses) and ekuboCore, a
// third-party contract Medialane doesn't own.
const PLATFORM_CONTRACT_KEYS = [
  "marketplace721", "marketplace1155",
  "collection721", "collection1155",
  "popFactory", "dropFactory",
  "nftComments",
  "creatorCoinFactory",
  "ipTicketsFactory", "ipClubFactory",
  "ipSponsorship",
  "genesisMintLaunch", "genesisMintBR", "genesisMintGlobal",
] as const;

function platformContracts(): Set<string> {
  const coords = getCoordinates("STARKNET");
  const set = new Set<string>();
  for (const key of PLATFORM_CONTRACT_KEYS) {
    const addr = coords[key];
    if (addr) set.add(normalizeAddress("STARKNET", addr));
  }
  return set;
}

// Entrypoints that make sense against any NFT/token a user owns, including
// ones Medialane didn't mint (e.g. listing someone else's NFT for sale).
// Everything else is only sponsorable against a contract Medialane actually
// controls.
const TOKEN_MOVEMENT_ENTRYPOINTS = new Set([
  "approve", "set_approval_for_all", "transfer", "transfer_from", "safe_transfer_from",
]);

export interface ContractAddressChecker {
  isEligible(entrypoint: string, contractAddress: string): Promise<boolean>;
}

export function createContractAddressChecker(db: Db): ContractAddressChecker {
  const trusted = platformContracts();
  return {
    async isEligible(entrypoint, contractAddress) {
      let normalized: string;
      try {
        normalized = normalizeAddress("STARKNET", contractAddress);
      } catch {
        return false;
      }

      if (trusted.has(normalized)) return true;
      if (getTokenByAddress(normalized)) return true;

      const service = await resolveServiceForContract(db, "STARKNET", normalized);
      if (service == null) return false;
      if (EXTERNAL_SERVICES.has(service)) return TOKEN_MOVEMENT_ENTRYPOINTS.has(entrypoint);
      return true;
    },
  };
}
