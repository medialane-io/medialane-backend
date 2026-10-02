
export const IDENTITY_SCHEME = {
  WALLET: "wallet",
  EMAIL: "email",
} as const;

export function emailValues(email: string): string[] {
  return [...new Set([email, normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email)])];
}

export function normalizeIdentityValue(scheme: string, value: string): string {
  const trimmed = value.trim();
  return scheme === IDENTITY_SCHEME.EMAIL ? trimmed.toLowerCase() : trimmed;
}
