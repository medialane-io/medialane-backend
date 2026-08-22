import { hasCapability } from "@medialane/sdk";

export const NON_ISSUANCE_MINT_SERVICES: ReadonlySet<string> = new Set([
  "pop-protocol",
  "drop-collection",
  "ip-tickets",
  "ip-club",
  "ip-sponsorship",
  "creator-coin",
]);

export function isIssuanceService(service: string | null | undefined): boolean {
  if (!service) return false;
  if (NON_ISSUANCE_MINT_SERVICES.has(service)) return false;
  return hasCapability(service, "mint");
}

export function mintActionForService(
  service: string | null | undefined
): "mint_asset" | null {
  return isIssuanceService(service) ? "mint_asset" : null;
}

export function creationActionForService(
  service: string | null | undefined
): "create_collection" | null {
  return isIssuanceService(service) ? "create_collection" : null;
}
