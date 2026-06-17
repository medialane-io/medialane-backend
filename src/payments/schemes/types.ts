// PaymentScheme isolates chain-specific verification from the x402 pipeline.
// Starknet is the only implementor today; a Base/EVM scheme drops in later.

/** Advertised in the 402 body (one per accepted scheme). */
export interface PaymentRequirement {
  scheme: string; // e.g. "starknet-transfer"
  network: string; // e.g. "starknet"
  asset: string; // token contract
  maxAmountRequired: string; // atomic units, as string
  payTo: string; // treasury
  nonce: string; // binds a payment to this 402 challenge
  resource: string; // request path
  description: string;
  mimeType: "application/json";
}

/** Decoded X-PAYMENT payload the agent sends on retry. */
export interface X402Payload {
  scheme: string;
  network: string;
  txHash: string; // the on-chain USDC transfer (push model)
  nonce: string; // echoes the requirement nonce
}

export interface VerifyResult {
  ok: boolean;
  amountAtomic?: bigint; // verified amount transferred to treasury
  payer?: string; // on-chain sender (for the MDLN bonus lookup)
  proofNonce?: string; // globally-unique key for replay dedup (e.g. `${txHash}:${nonce}`)
  reason?: string; // populated when ok=false
}

export interface PaymentScheme {
  readonly scheme: string;
  readonly network: string;
  buildRequirement(args: { amountAtomic: bigint; resource: string; nonce: string }): PaymentRequirement;
  verify(payload: X402Payload): Promise<VerifyResult>;
}
