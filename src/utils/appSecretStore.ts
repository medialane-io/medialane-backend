export function nextSecretHashes(current: string[], newHash: string, replace: boolean): string[] {
  return replace ? [newHash] : [...current.slice(-1), newHash];
}
