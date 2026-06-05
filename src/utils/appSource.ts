import type { AppSource } from "@prisma/client";

/**
 * Accepted appSource inputs at the API edge.
 *
 * `MEDIALANE_DAPP` is a TRANSITION ALIAS for `MEDIALANE_STARKNET` (the enum value was
 * renamed when the model went multichain — the "dapp" is specifically the Starknet app).
 * The alias keeps live dapp/SDK clients working during cutover; `normalizeAppSource`
 * maps it to the canonical value before any DB write. Remove the alias once the
 * dapp + SDK ship `MEDIALANE_STARKNET`.
 */
export const APP_SOURCE_INPUT = [
  "MEDIALANE_DAPP",
  "MEDIALANE_STARKNET",
  "MEDIALANE_IO",
  "MEDIALANE_PORTAL",
  "MEDIALANE_SDK",
] as const;

export function normalizeAppSource(s: string): AppSource {
  return (s === "MEDIALANE_DAPP" ? "MEDIALANE_STARKNET" : s) as AppSource;
}
