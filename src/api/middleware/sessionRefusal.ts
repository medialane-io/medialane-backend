import { SESSION_ERROR_CODES } from "@medialane/sdk";

export const SIGN_IN_REQUIRED = { error: "Sign in to continue", code: SESSION_ERROR_CODES.signInRequired } as const;
export const ACCOUNT_INACTIVE = { error: "Account is not active", code: SESSION_ERROR_CODES.accountInactive } as const;
