export type FundingStatus = "PENDING" | "SETTLED" | "FAILED" | "EXPIRED";

export interface FundingIntentRecord {
  id: string;
  apiClientId: string;
  method: string;
  status: FundingStatus;
  payer: string | null;
  params: Record<string, unknown>;
  expiresAt: Date;
}

export interface VerifiedPayment {
  /** What the payment is worth in USDC atomic units (6 decimals). The method computes it from the chain. */
  valueUsdcAtomic: bigint;
  asset: string;
  payer?: string;
  proofNonce: string;
  scheme: string;
  network: string;
  txHash: string;
}

export interface SettleInput {
  intent: FundingIntentRecord;
  verified: VerifiedPayment;
  credited: number;
  multiplier: number;
}

export type SettleOutcome =
  | { outcome: "settled"; paymentId: string }
  | { outcome: "not-open" }
  | { outcome: "duplicate" };

export interface FundingStore {
  create(input: {
    apiClientId: string;
    method: string;
    params: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<FundingIntentRecord>;
  get(id: string, apiClientId: string): Promise<FundingIntentRecord | null>;
  setPayer(id: string, apiClientId: string, payer: string, now: Date): Promise<boolean>;
  openForPayer(payer: string, now: Date): Promise<FundingIntentRecord[]>;
  cancel(id: string, apiClientId: string): Promise<boolean>;
  settle(input: SettleInput): Promise<SettleOutcome>;
}

export type MethodResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface FundingMethod {
  readonly id: string;
  available(): boolean;
  describe(): Record<string, unknown>;
  parseParams(raw: unknown): MethodResult<{ params: Record<string, unknown> }>;
  challenge(intent: FundingIntentRecord, body: unknown): MethodResult<{ typedData: unknown }>;
  authorize(
    intent: FundingIntentRecord,
    body: unknown,
  ): Promise<MethodResult<{ payer: string; instructions: Record<string, unknown> }>>;
  verify(
    intent: FundingIntentRecord,
    evidence: unknown,
  ): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; reason: string }>;
}
