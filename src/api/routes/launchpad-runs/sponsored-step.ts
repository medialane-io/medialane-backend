import type { Context } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import type { StepState } from "../../../launchpad/services/data-tokenization/progress.js";
import { executeSponsoredInvoke } from "../paymaster.js";
import type { RunContext, RunReceipt } from "./context.js";

export interface StepTarget {
  runId: string;
  apiClientId: string;
  path: string[];
  credits: number;
  label: string;
}

export async function executeStep(
  ctx: RunContext,
  c: Context<AppEnv>,
  target: StepTarget & { userAddress: string; typedData?: unknown; signature: string[]; calls: unknown[] },
): Promise<Response> {
  const { runId: id, apiClientId, credits, path } = target;
  if (!(await ctx.store.reserve({ id, apiClientId, credits, path, retryReverted: true }))) {
    return c.json({ error: `${target.label} is already on its way` }, 409);
  }

  const outcome = await executeSponsoredInvoke(ctx.execution().sponsored, {
    userAddress: target.userAddress,
    typedData: target.typedData,
    signature: target.signature,
    calls: target.calls,
  });
  if (outcome.status !== 200) {
    await ctx.store.release({ id, apiClientId, credits, path });
    return c.json(outcome.body, outcome.status);
  }

  const txHash = String(outcome.body.transactionHash);
  await ctx.store.record(id, apiClientId, path, { txHash, status: "SUBMITTED" });
  return c.json({ transactionHash: txHash });
}

export async function confirmStep(
  ctx: RunContext,
  c: Context<AppEnv>,
  target: StepTarget & {
    state: StepState | undefined;
    extra?: Record<string, unknown>;
    onSucceeded(receipt: RunReceipt, txHash: string): Promise<Response>;
  },
): Promise<Response> {
  const { runId: id, apiClientId, credits, path, state } = target;
  if (!state || state.status !== "SUBMITTED") {
    return c.json({ error: `${target.label} has nothing waiting to confirm` }, 409);
  }

  const receipt = await ctx.execution().receipt(state.txHash);
  if (receipt.status === "PENDING") return c.json({ data: { ...target.extra, status: receipt.status } }, 202);

  if (receipt.status === "REVERTED") {
    await ctx.store.release({ id, apiClientId, credits, path });
    await ctx.store.record(id, apiClientId, path, { txHash: state.txHash, status: "REVERTED" });
    return c.json({ data: { ...target.extra, status: receipt.status } });
  }

  return target.onSucceeded(receipt, state.txHash);
}
