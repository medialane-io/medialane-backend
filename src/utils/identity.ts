
export const IDENTITY_SCHEME = {
  WALLET: "wallet",

  CLERK: "clerk",
  EMAIL: "email",
} as const;

export function normalizeIdentityValue(scheme: string, value: string): string {
  const trimmed = value.trim();
  return scheme === IDENTITY_SCHEME.EMAIL ? trimmed.toLowerCase() : trimmed;
}
