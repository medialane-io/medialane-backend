/** Token standards a Collection row may carry. ERC20 = creator coins / memecoins
 *  (the DB column holds it even though the SDK ApiCollection union omits it). */
const KNOWN_STANDARDS = new Set(["ERC721", "ERC1155", "ERC20"]);

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
