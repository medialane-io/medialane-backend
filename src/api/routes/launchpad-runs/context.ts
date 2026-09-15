import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/hono.js";
import prisma from "../../../db/client.js";
import { callRpc } from "../../../utils/starknet.js";
import { creditsForAction } from "../../../payments/pricing.js";
import { createSignedUpload, findPinnedFile, uploadJson } from "../../../orchestrator/metadataPin.js";
import type { RunStore } from "../../../launchpad/run-store.js";
import type { PriceOf } from "../../../launchpad/steps.js";
import { creditFromTransaction, type CreditedPayment } from "../../../mirror/handlers/treasuryDeposit.js";
import {
  dataTokenizationRegistry,
  productionMintCallDeps,
  type MintCallDeps,
} from "../../../launchpad/services/data-tokenization/mint-calls.js";
import { defaultClient, type SponsoredInvokeDeps } from "../paymaster.js";
import { createContractAddressChecker } from "../paymaster-contract-address.js";

export type ReceiptStatus = "SUCCEEDED" | "REVERTED" | "PENDING";

export interface ReceiptEvent {
  from_address?: string;
  keys?: string[];
  data?: string[];
}

export interface RunReceipt {
  status: ReceiptStatus;
  events: ReceiptEvent[];
}

export interface ExecutionDeps {
  signedUpload(input: { name: string; size: number; type: string; keyvalues: Record<string, string> }): Promise<string>;
  pinnedFile(cid: string): Promise<{ size: number; keyvalues: Record<string, string> } | null>;
  pinJson(data: Record<string, unknown>): Promise<string>;
  mintCalls: MintCallDeps;
  sponsored: SponsoredInvokeDeps;
  receipt(txHash: string): Promise<RunReceipt>;
  registry(): string;
}

export type SettleWalletPayment = (txHash: string) => Promise<{ payments: CreditedPayment[] }>;

export interface RunRouteDeps {
  store: RunStore;
  priceOf?: PriceOf;
  settleWalletPayment?: SettleWalletPayment;
  execution?: ExecutionDeps;
}

export interface RunContext {
  store: RunStore;
  priceOf: PriceOf;
  settleWalletPayment: SettleWalletPayment;
  execution(): ExecutionDeps;
}

async function productionReceipt(txHash: string): Promise<RunReceipt> {
  try {
    const receipt = (await callRpc((provider) => provider.getTransactionReceipt(txHash))) as {
      execution_status?: string;
      events?: ReceiptEvent[];
    };
    const status: ReceiptStatus =
      receipt.execution_status === "SUCCEEDED" ? "SUCCEEDED" : receipt.execution_status === "REVERTED" ? "REVERTED" : "PENDING";
    return { status, events: receipt.events ?? [] };
  } catch {
    return { status: "PENDING", events: [] };
  }
}

function productionExecution(): ExecutionDeps {
  return {
    signedUpload: createSignedUpload,
    pinnedFile: findPinnedFile,
    pinJson: uploadJson,
    mintCalls: productionMintCallDeps,
    sponsored: { clientFactory: defaultClient, addressChecker: createContractAddressChecker(prisma) },
    receipt: productionReceipt,
    registry: dataTokenizationRegistry,
  };
}

export function createRunContext(deps: RunRouteDeps): RunContext {
  let execution = deps.execution;
  return {
    store: deps.store,
    priceOf: deps.priceOf ?? ((action) => creditsForAction(action)),
    settleWalletPayment: deps.settleWalletPayment ?? ((txHash) => creditFromTransaction(txHash)),
    execution: () => (execution ??= productionExecution()),
  };
}

export const walletBody = z.object({ userAddress: z.string().min(3) }).passthrough();

export const executeBody = z.object({
  userAddress: z.string().min(3),
  typedData: z.unknown(),
  signature: z.array(z.string()).min(1),
});

export function specError(err: unknown) {
  if (err instanceof z.ZodError) {
    return { error: "The run is not complete", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  return { error: "The run is not complete" };
}

export function ownsWallet(ctx: RunContext, c: Context<AppEnv>, address: string): Promise<boolean> {
  return ctx.store.ownsWallet(c.get("account").id, address);
}

export function indexParam(c: Context<AppEnv>): number | null {
  const index = Number(c.req.param("index"));
  return Number.isInteger(index) && index >= 0 ? index : null;
}
