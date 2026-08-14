import { executeAllPaymasterFlow, type InvokePaymasterParams } from "@avnu/avnu-sdk";
import { PaymasterRpc, type AccountInterface, type Call } from "starknet";

const AVNU_PAYMASTER_NODE_URL = "https://starknet.paymaster.avnu.fi";

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
