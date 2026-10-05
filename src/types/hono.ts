import type { ApiKeyStatus, Plan, AccountStatus } from "@prisma/client";

export type AuthedAccount = {
  id: string;
  status: AccountStatus;
};

export type AuthedApiCredits = {
  id: string;
  accountId: string;
  plan: Plan;
  creditBalance: number;
};
export type AuthedApiKey = {
  id: string;
  status: ApiKeyStatus;
  apiCredits: AuthedApiCredits & { account: AuthedAccount };
};

export type AppVariables = {
  requestId: string;

  account: AuthedAccount;

  apiCredits: AuthedApiCredits;
  apiKey: AuthedApiKey;
  walletAddress?: string;

  subjectTokenIssuedAt?: number;

  billedUnits?: number;
};

export type AppEnv = { Variables: AppVariables };
