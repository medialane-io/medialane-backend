/** Token standards a Collection row may carry. Collection is NFT-only since the
 *  2026-06-14 coin split — fungible coins live in the Coin table, served by
 *  /v1/coins, never here. */
const KNOWN_STANDARDS = new Set(["ERC721", "ERC1155"]);

/**
 * Parse the `standard` query param (single value or CSV) into a validated,
 * de-duplicated list, or null when no usable filter is present.
 *
 *   parseStandardFilter("ERC20")            -> ["ERC20"]
 *   parseStandardFilter("erc721, erc1155")  -> ["ERC721", "ERC1155"]
 *   parseStandardFilter("FOO")              -> null
 */
export function parseStandardFilter(raw: string | undefined | null): string[] | null {
  if (!raw) return null;
  const parsed = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => KNOWN_STANDARDS.has(s))
    )
  );
  return parsed.length > 0 ? parsed : null;
}
