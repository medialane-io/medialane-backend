/**
 * The partition invariant: one on-chain action earns XP for exactly one
 * action type. Mint Transfers and Collection creations are classified by
 * the collection's service so drops/pops never double-count as generic
 * mints/creations.
 */
const ISSUANCE_SERVICES = new Set(["mip-erc721", "mip-erc1155", "ip-erc721"]);

export function mintActionForService(
  service: string | null | undefined
): "mint_asset" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "mint_asset";
  return null; // pop/drop have claim_* actions; external/marketplace score nothing
}

export function creationActionForService(
  service: string | null | undefined
): "create_collection" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "create_collection";
  return null; // drop/pop creations are launch_launchpad
}
