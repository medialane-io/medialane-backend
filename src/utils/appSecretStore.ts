/** An app keeps at most two valid secrets: the newest previous one and the new one. */
export function nextSecretHashes(current: string[], newHash: string, replace: boolean): string[] {
  return replace ? [newHash] : [...current.slice(-1), newHash];
}
