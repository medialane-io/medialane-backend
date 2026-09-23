import { getCoordinates, getTokenByAddress, normalizeAddress } from "@medialane/sdk";
import { resolveServiceForContract } from "../../utils/collection.js";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const PLATFORM_CONTRACT_KEYS = [
  "marketplace721", "marketplace1155",
  "collection721", "dataTokenization721", "collection1155",
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

export interface ContractAddressChecker {
  isEligible(contractAddress: string): Promise<boolean>;
}

export function createContractAddressChecker(db: Db): ContractAddressChecker {
  const trusted = platformContracts();
  return {
    async isEligible(contractAddress) {
      let normalized: string;
      try {
        normalized = normalizeAddress("STARKNET", contractAddress);
      } catch {
        return false;
      }

      if (trusted.has(normalized)) return true;
      if (getTokenByAddress(normalized)) return true;

      if ((await resolveServiceForContract(db, "STARKNET", normalized)) != null) return true;

      const provisioned = await db.businessProvisioning.findFirst({
        where: { chain: "STARKNET", walletAddress: normalized },
        select: { id: true },
      });
      return provisioned != null;
    },
  };
}
