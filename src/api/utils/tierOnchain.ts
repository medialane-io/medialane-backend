export interface TierOnchain {
  maxSupply: string;
  minted: string;
  startTime: number | null;
  endTime: number | null;
  royaltyBps: number;
}

function parseOption(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && typeof (v as { unwrap?: unknown }).unwrap === "function") {
    const inner = (v as { unwrap: () => unknown }).unwrap();
    return inner != null ? Number(inner) : null;
  }
  if (typeof v === "bigint" || typeof v === "number") return Number(v);
  return null;
}

export function parseTierResult(raw: {
  max_supply: bigint | number | string;
  minted: bigint | number | string;
  start_time: unknown;
  end_time: unknown;
  royalty_bps: bigint | number | string;
}): TierOnchain {
  return {
    maxSupply: raw.max_supply.toString(),
    minted: raw.minted.toString(),
    startTime: parseOption(raw.start_time),
    endTime: parseOption(raw.end_time),
    royaltyBps: Number(raw.royalty_bps),
  };
}
