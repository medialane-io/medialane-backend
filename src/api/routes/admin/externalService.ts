/** Default `service` ID for an admin-added external collection of a given standard.
 *  external-erc20 = claimed unrug/partner coins (05-service-model). */
export function defaultExternalService(standard: "ERC721" | "ERC1155" | "ERC20"): string {
  switch (standard) {
    case "ERC1155": return "external-erc1155";
    case "ERC20":   return "external-erc20";
    default:        return "external-erc721";
  }
}
