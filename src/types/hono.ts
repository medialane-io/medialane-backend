import type { AccountStatus } from "@prisma/client";

export type AuthedAccount = {
  id: string;
  status: AccountStatus;
};

export type AuthedApiCredits = {
  id: string;
  accountId: string;
  creditBalance: number;
};
export type AuthedApiKey = {
  id: string;
  apiCredits: AuthedApiCredits & { account: AuthedAccount };
};

export type AppVariables = {
  requestId: string;

  account: AuthedAccount;

  appId: string;

  apiCredits: AuthedApiCredits;
  apiKey: AuthedApiKey;
  walletAddress?: string;
  sponsorWallet?: string;
  sessionAccountId?: string;


  billedUnits?: number;
  billedCredits?: number;
};

export type AppEnv = { Variables: AppVariables };
