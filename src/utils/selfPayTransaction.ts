import { constants, hash, num, transaction, type Call } from "starknet";
import type { VerifyResult } from "../chains/adapter.js";
import { isContractError, isContractNotFound } from "./starknet.js";

const VALID = 0x56414c4944n;

const FELT = /^(0x[0-9a-fA-F]+|[0-9]+)$/;
const RESOURCES = ["l1_gas", "l2_gas", "l1_data_gas"] as const;

type Resource = (typeof RESOURCES)[number];

export interface SelfPayDetails {
  nonce: bigint;
  tip: bigint;
  resourceBounds: Record<Resource, { max_amount: bigint; max_price_per_unit: bigint }>;
}

function felt(value: unknown): bigint | null {
  return typeof value === "string" && value.length <= 80 && FELT.test(value) ? BigInt(value) : null;
}

export function parseSelfPayDetails(body: unknown): SelfPayDetails | null {
  const input = body as { nonce?: unknown; tip?: unknown; resourceBounds?: Record<string, Record<string, unknown> | undefined> } | null;
  const nonce = felt(input?.nonce);
  const tip = felt(input?.tip);
  if (nonce === null || tip === null) return null;
  const resourceBounds = {} as SelfPayDetails["resourceBounds"];
  for (const resource of RESOURCES) {
    const amount = felt(input?.resourceBounds?.[resource]?.max_amount);
    const price = felt(input?.resourceBounds?.[resource]?.max_price_per_unit);
    if (amount === null || price === null) return null;
    resourceBounds[resource] = { max_amount: amount, max_price_per_unit: price };
  }
  return { nonce, tip, resourceBounds };
}

export function selfPayTransactionHash(wallet: string, calls: Call[], details: SelfPayDetails): string {
  return hash.calculateInvokeTransactionHash({
    senderAddress: wallet,
    version: "0x3",
    compiledCalldata: transaction.getExecuteCalldata(calls, "1"),
    chainId: constants.StarknetChainId.SN_MAIN,
    nonce: details.nonce,
    tip: details.tip,
    resourceBounds: details.resourceBounds,
    accountDeploymentData: [],
    paymasterData: [],
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
  } as never);
}

export async function walletAccepts(
  call: (request: Call & { calldata: string[] }) => Promise<string[]>,
  wallet: string,
  transactionHash: string,
  signature: string[],
): Promise<VerifyResult> {
  try {
    const [answer] = await call({
      contractAddress: wallet,
      entrypoint: "is_valid_signature",
      calldata: [transactionHash, num.toHex(signature.length), ...signature],
    });
    return answer !== undefined && (BigInt(answer) === VALID || BigInt(answer) === 1n) ? { ok: true } : { ok: false, reason: "invalid" };
  } catch (err) {
    if (isContractNotFound(err)) return { ok: false, reason: "not_deployed" };
    if (isContractError(err)) return { ok: false, reason: "invalid" };
    throw err;
  }
}
