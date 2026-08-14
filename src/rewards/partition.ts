
const ISSUANCE_SERVICES = new Set(["mip-erc721", "mip-erc1155", "ip-erc721"]);

export function mintActionForService(
  service: string | null | undefined
): "mint_asset" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "mint_asset";
  return null;
}

export function creationActionForService(
  service: string | null | undefined
): "create_collection" | null {
  if (!service) return null;
  if (ISSUANCE_SERVICES.has(service)) return "create_collection";
  return null;
}
