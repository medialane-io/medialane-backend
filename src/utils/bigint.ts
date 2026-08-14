
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

export function feltToBigInt(felt: string): bigint {
  try {
    if (felt.startsWith("0x") || felt.startsWith("0X")) {
      return BigInt(felt);
    }
    return BigInt(felt);
  } catch {
    return 0n;
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

export function bigIntToString(n: bigint): string {
  return n.toString();
}
