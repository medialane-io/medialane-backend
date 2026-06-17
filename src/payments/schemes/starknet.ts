import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { x402Config } from "../../config/x402.js";
import type { PaymentRequirement, PaymentScheme, VerifyResult, X402Payload } from "./types.js";

// ERC-20 Transfer event selector on Starknet (Cairo). Same value the retired
// portal USDC-deposit poll used.
const TRANSFER_KEY = "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";

function u256FromLowHigh(low: string, high: string): bigint {
  return BigInt(low ?? "0x0") + (BigInt(high ?? "0x0") << 128n);
}

interface StarknetReceipt {
  execution_status?: string;
  finality_status?: string;
  events?: Array<{ from_address: string; keys: string[]; data: string[] }>;
}

/**
 * Push model: the agent has already transferred USDC to the treasury. verify()
 * confirms the tx is finalized, contains a USDC Transfer to the treasury, and
 * reports the amount + payer. settle() is implicit (funds already moved), so
 * this scheme exposes only verify().
 */
export class StarknetUsdcScheme implements PaymentScheme {
  readonly scheme = "starknet-transfer";
  readonly network = "starknet";

  buildRequirement(args: { amountAtomic: bigint; resource: string; nonce: string }): PaymentRequirement {
    return {
      scheme: this.scheme,
      network: this.network,
      asset: x402Config.usdcContract,
      maxAmountRequired: args.amountAtomic.toString(),
      payTo: x402Config.treasury,
      nonce: args.nonce,
      resource: args.resource,
      description: `Pay ${args.amountAtomic} USDC atomic units to fund API credits`,
      mimeType: "application/json",
    };
  }

  async verify(payload: X402Payload): Promise<VerifyResult> {
    if (!x402Config.treasury) return { ok: false, reason: "treasury not configured" };

    let receipt: StarknetReceipt;
    try {
      receipt = await callRpc((provider) =>
        (provider as { getTransactionReceipt: (h: string) => Promise<StarknetReceipt> }).getTransactionReceipt(
          payload.txHash,
        ),
      );
    } catch {
      return { ok: false, reason: "could not fetch receipt" };
    }

    if (receipt.execution_status && receipt.execution_status !== "SUCCEEDED") {
      return { ok: false, reason: "transaction reverted" };
    }

    const usdc = normalizeAddress(x402Config.usdcContract);
    const treasury = normalizeAddress(x402Config.treasury);

    for (const ev of receipt.events ?? []) {
      if (normalizeAddress(ev.from_address) !== usdc) continue;
      if (ev.keys[0] !== TRANSFER_KEY) continue;
      // keys: [Transfer, from, to]; data: [amount_low, amount_high].
      const from = ev.keys[1];
      const to = ev.keys[2];
      if (!to || normalizeAddress(to) !== treasury) continue;
      const amount = u256FromLowHigh(ev.data[0], ev.data[1]);
      return {
        ok: true,
        amountAtomic: amount,
        payer: from ? normalizeAddress(from) : undefined,
        proofNonce: `${payload.txHash}:${payload.nonce}`,
      };
    }
    return { ok: false, reason: "no USDC transfer to treasury found" };
  }
}
