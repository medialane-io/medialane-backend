
export function formatAmount(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw);
    const divisor = BigInt(10 ** decimals);
    const whole = n / divisor;
    const remainder = n % divisor;
    const fracStr = remainder.toString().padStart(decimals, "0");
    return `${whole}.${fracStr}`;
  } catch {
    return raw;
  }
}

export function u256ToBigInt(low: string, high: string): bigint {
  try {
    const lo = BigInt(low);
    const hi = BigInt(high);
    return lo + hi * (2n ** 128n);
  } catch {
    return 0n;
  }
}
