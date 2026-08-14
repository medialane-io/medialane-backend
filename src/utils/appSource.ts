import type { AppSource } from "@prisma/client";

export const APP_SOURCE_INPUT = [
  "MEDIALANE_DAPP",
  "MEDIALANE_STARKNET",
  "MEDIALANE_IO",
  "MEDIALANE_PORTAL",
  "MEDIALANE_DAO",
  "MEDIALANE_SDK",
] as const;

export function normalizeAppSource(s: string): AppSource {
  return (s === "MEDIALANE_DAPP" ? "MEDIALANE_STARKNET" : s) as AppSource;
}
