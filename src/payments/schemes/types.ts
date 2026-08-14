

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
  proofNonce?: string;
  reason?: string;
}

export interface PaymentScheme {
  readonly scheme: string;
  readonly network: string;
  buildRequirement(args: { amountAtomic: bigint; resource: string; nonce: string }): PaymentRequirement;
  verify(payload: X402Payload): Promise<VerifyResult>;
}
