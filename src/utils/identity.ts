/**
 * Identity scheme vocabulary.
 *
 * `Identity.scheme` is intentionally free-form — the platform never gates the format,
 * an app may store any scheme (07-identity-model.md). These are the schemes the
 * BACKEND itself writes and reads, centralized so a typo in a Prisma `where`/`data`
 * can't silently match nothing.
 *
 * NOTE: raw-SQL sites (`$queryRaw`/`$executeRaw` in search.ts, compute-rewards.ts,
 * verify-account-model.ts) keep the bare string literal `'wallet'` — they must be
 * kept in sync with the values here.
 */
export const IDENTITY_SCHEME = {
  WALLET: "wallet",
  // Legacy — no longer written. medialane-io migrated off its previous
  // identity provider to a self-custody wallet model (2026-08-07); kept
  // here only so historical rows for existing accounts still read correctly.
  CLERK: "clerk",
  EMAIL: "email",
} as const;
