import { executeAllPaymasterFlow, type InvokePaymasterParams } from "@avnu/avnu-sdk";
import { PaymasterRpc, type AccountInterface, type Call } from "starknet";

const AVNU_PAYMASTER_NODE_URL = "https://starknet.paymaster.avnu.fi";

/**
 * Wraps AVNU's gasfree paymaster flow (sponsored fee mode, SNIP-9 outside
 * execution under the hood). The API key stays server-side only — AVNU's own
 * integration docs warn it leaks if used client-side — so this module is
 * backend-only, never imported into a browser bundle. Not yet wired into any
 * `/v1/intents/*` route; that integration needs a live portal.avnu.fi key
 * (Propulsion Program or Medialane-funded) to test against.
 */

export function isPaymasterConfigured(): boolean {
  return Boolean(process.env.AVNU_PAYMASTER_API_KEY);
}

export async function sponsorCalls(
  account: AccountInterface,
  calls: Call[],
): Promise<{ transactionHash: string }> {
  const apiKey = process.env.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) throw new Error("AVNU_PAYMASTER_API_KEY is not set");

  const paymaster: InvokePaymasterParams = {
    active: true,
    provider: new PaymasterRpc({
      nodeUrl: AVNU_PAYMASTER_NODE_URL,
      headers: { "x-paymaster-api-key": apiKey },
    }),
    params: { version: "0x1", feeMode: { mode: "sponsored" } },
  };

  const result = await executeAllPaymasterFlow({ paymaster, provider: account, calls });
  return { transactionHash: result.transactionHash };
}
