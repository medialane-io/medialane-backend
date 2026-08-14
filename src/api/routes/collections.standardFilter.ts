
const KNOWN_STANDARDS = new Set(["ERC721", "ERC1155"]);

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
