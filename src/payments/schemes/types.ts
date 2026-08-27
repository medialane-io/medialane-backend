import type { CanonicalHash } from "@medialane/sdk";



export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  nonce: string;
  resource: string;
  description: string;
  mimeType: "application/json";
}

export interface X402Payload {
  scheme: string;
  network: string;
  txHash: string;
  nonce: string;
}

export interface VerifyResult {
  ok: boolean;
  amountAtomic?: bigint;
  payer?: string;
  /**
   * Carries the unique constraint that stops one on-chain payment crediting an
   * account twice, so it must be a canonical hash. Typed as CanonicalHash —
   * which only normalizeHash can produce — because this field previously held
   * the caller's raw txHash, and a felt has many equal spellings: one payment
   * presented three ways yielded three nonces and three credits.
   */
  proofNonce?: CanonicalHash;
  reason?: string;
}

export interface PaymentScheme {
  readonly scheme: string;
  readonly network: string;
  buildRequirement(args: { amountAtomic: bigint; resource: string; nonce: string }): PaymentRequirement;
  verify(payload: X402Payload): Promise<VerifyResult>;
}
