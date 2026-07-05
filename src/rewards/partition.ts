/**
 * The partition invariant: one on-chain action earns XP for exactly one
 * action type. Mint Transfers and Collection creations are classified by
 * the collection's service so tickets/clubs/drops/pops never double-count
 * as generic mints/creations.
 */
const ISSUANCE_SERVICES = new Set(["mip-erc721", "mip-erc1155", "ip-erc721"]);

export function mintActionForService(
  service: string | null | undefined
): "mint_asset" | "buy_ticket" | "join_club" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "mint_asset";
  if (service === "ip-tickets") return "buy_ticket";
  if (service === "ip-club") return "join_club";
  return null; // pop/drop have claim_* actions; external/marketplace score nothing
}

export function creationActionForService(
  service: string | null | undefined
): "create_collection" | "create_ticket_collection" | "create_club" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "create_collection";
  if (service === "ip-tickets") return "create_ticket_collection";
  if (service === "ip-club") return "create_club";
  return null; // drop/pop creations are launch_launchpad
}
