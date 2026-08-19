import type { ApiKeyStatus, Plan, AccountStatus } from "@prisma/client";

export type AuthedAccount = {
  id: string;
  status: AccountStatus;
};

export type AuthedApiClient = {
  id: string;
  accountId: string;
  plan: Plan;
  creditBalance: number;
};
export type AuthedApiKey = {
  id: string;
  status: ApiKeyStatus;
  apiClient: AuthedApiClient & { account: AuthedAccount };
};

export type AppVariables = {
  requestId: string;

  account: AuthedAccount;

  apiClient: AuthedApiClient;
  apiKey: AuthedApiKey;
  walletAddress?: string;
};

export type AppEnv = { Variables: AppVariables };
