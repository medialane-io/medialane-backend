import type { TokenStandard } from "@prisma/client";

export function includeBalances(standard: TokenStandard | null | undefined): boolean {
  return standard === "ERC721";
}
