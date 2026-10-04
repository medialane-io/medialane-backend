export function pendingPaths(progress: unknown, prefix: string[] = []): string[][] {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return [];
  const node = progress as Record<string, unknown>;
  if (node.status === "PENDING" && typeof node.credits === "number") return [prefix];
  return Object.entries(node).flatMap(([key, value]) => pendingPaths(value, [...prefix, key]));
}
