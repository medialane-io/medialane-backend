export function sameFelt(a: unknown, b: unknown): boolean {
  if (a == null || b == null || a === "" || b === "") return false;
  try {
    return BigInt(a as string) === BigInt(b as string);
  } catch {
    return false;
  }
}
