import { Hono, type MiddlewareHandler } from "hono";
import { requireSession } from "../middleware/sessionGuard.js";
import { CallData, PaymasterRpc, hash, uint256, type Call } from "starknet";
import { getTokenBySymbol, getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:paymaster");

const AVNU_PAYMASTER_URL = "https://starknet.paymaster.avnu.fi";
const SPONSORED = { version: "0x1", feeMode: { mode: "sponsored" } } as const;

export interface PaymasterClient {
  buildTransaction(req: unknown, opts: unknown): Promise<unknown>;
  executeTransaction(req: unknown, opts: unknown): Promise<unknown>;
}

export function defaultClient(): PaymasterClient {
  const apiKey = process.env.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) throw new Error("AVNU_PAYMASTER_API_KEY is not set");
  return new PaymasterRpc({
    nodeUrl: AVNU_PAYMASTER_URL,
    headers: { "x-paymaster-api-key": apiKey },
  }) as unknown as PaymasterClient;
}

export type SponsorshipFailureCode =
  | "sponsor_unavailable"
  | "credits_exhausted"
  | "account_not_deployed"
  | "not_executable"
  | "invalid_request"
  | "invalid_request_auth"
  | "rate_limited"
  | "may_have_broadcast";

export interface PaymasterErrorResult {
  status: 422 | 502 | 503;
  message: string;
  code: SponsorshipFailureCode;
}

export function classifyPaymasterError(err: unknown, stage: "build" | "execute" = "build"): PaymasterErrorResult {
  const text =
    err instanceof Error
      ? `${err.message}`
      : typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err ?? "");

  if (text.includes("AVNU_PAYMASTER_API_KEY")) {
    return { status: 503, message: "Gas sponsorship is not configured", code: "sponsor_unavailable" };
  }

  if (text.includes("ENTRYPOINT_NOT_FOUND")) {
    return {
      status: 422,
      message: "The account is not deployed yet, so it cannot sign a sponsored transaction",
      code: "account_not_deployed",
    };
  }

  if (text.includes("TRANSACTION_EXECUTION_ERROR") || text.includes("execution_error")) {
    return { status: 422, message: "The transaction could not be executed as submitted", code: "not_executable" };
  }

  if (stage === "execute") {
    return { status: 502, message: "The sponsored transaction may have been submitted. Check your activity before trying again.", code: "may_have_broadcast" };
  }
  return { status: 502, message: "Gas sponsorship is temporarily unavailable", code: "sponsor_unavailable" };
}

interface SignedCall {
  To?: unknown;
  Selector?: unknown;
  Calldata?: unknown;
}

function sameFelt(a: unknown, b: unknown): boolean {
  try {
    return BigInt(a as string) === BigInt(b as string);
  } catch {
    return false;
  }
}

function isEmptyCall(call: SignedCall): boolean {
  return sameFelt(call.To, "0x0") && sameFelt(call.Selector, "0x0") && Array.isArray(call.Calldata) && call.Calldata.length === 0;
}

export function typedDataMatchesCalls(
  typedData: unknown,
  calls: readonly { contractAddress: string; entrypoint: string; calldata: readonly string[] }[],
): boolean {
  const signed = (typedData as { message?: { Calls?: unknown } } | null)?.message?.Calls;
  if (!Array.isArray(signed)) return false;
  const trailingFeeCall = signed.length === calls.length + 1 && isEmptyCall(signed[calls.length] as SignedCall);
  if (signed.length !== calls.length && !trailingFeeCall) return false;
  return calls.every((call, i) => {
    const s = signed[i] as SignedCall;
    return (
      sameFelt(s.To, call.contractAddress) &&
      sameFelt(s.Selector, hash.getSelectorFromName(call.entrypoint)) &&
      Array.isArray(s.Calldata) &&
      s.Calldata.length === call.calldata.length &&
      s.Calldata.every((value, j) => sameFelt(value, call.calldata[j]))
    );
  });
}

function txHashOf(result: unknown): string {
  return (result as { transaction_hash: string }).transaction_hash;
}

export async function executeSponsoredDeploy(
  input: { ownerAddress: string; typedData: unknown; signature: string[]; deployment: unknown },
  clientFactory: () => PaymasterClient = defaultClient,
): Promise<string> {
  const result = await clientFactory().executeTransaction(
    {
      type: "deploy_and_invoke",
      deployment: input.deployment,
      invoke: {
        userAddress: input.ownerAddress,
        typedData: input.typedData,
        signature: input.signature,
      },
    },
    SPONSORED,
  );
  return txHashOf(result);
}

export async function executeOwnSponsoredInvoke(
  input: { userAddress: string; calls: Call[]; sign: (typedData: unknown) => string[] },
  clientFactory: () => PaymasterClient = defaultClient,
): Promise<string> {
  const client = clientFactory();
  const prepared = (await client.buildTransaction(
    { type: "invoke", invoke: { userAddress: input.userAddress, calls: input.calls } },
    SPONSORED,
  )) as { typed_data: unknown };
  const result = await client.executeTransaction(
    {
      type: "invoke",
      invoke: { userAddress: input.userAddress, typedData: prepared.typed_data, signature: input.sign(prepared.typed_data) },
    },
    SPONSORED,
  );
  return txHashOf(result);
}

export interface SponsoredInvokeDeps {
  clientFactory: () => PaymasterClient;
}

export type SponsoredOutcome =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 422 | 502 | 503; body: { error: string; code: SponsorshipFailureCode } };

export async function buildSponsoredInvoke(
  deps: SponsoredInvokeDeps,
  body: { userAddress?: string; calls?: unknown[] },
): Promise<SponsoredOutcome> {
  if (!body.userAddress || !body.calls?.length) {
    return { status: 400, body: { error: "userAddress and a non-empty calls array are required", code: "invalid_request" } };
  }
  try {
    const prepared = (await deps.clientFactory().buildTransaction(
      { type: "invoke", invoke: { userAddress: body.userAddress, calls: body.calls } },
      SPONSORED,
    )) as { typed_data: unknown };
    return { status: 200, body: { typedData: prepared.typed_data } };
  } catch (err) {
    const failure = classifyPaymasterError(err);
    log.warn({ err, status: failure.status }, "sponsored invoke build failed");
    return { status: failure.status, body: { error: failure.message, code: failure.code } };
  }
}

export async function executeSponsoredInvoke(
  deps: SponsoredInvokeDeps,
  body: { userAddress?: string; typedData?: unknown; signature?: string[] },
): Promise<SponsoredOutcome> {
  if (!body.userAddress || !body.typedData || !body.signature) {
    return { status: 400, body: { error: "userAddress, typedData and signature are required", code: "invalid_request" } };
  }
  try {
    const result = await deps.clientFactory().executeTransaction(
      {
        type: "invoke",
        invoke: { userAddress: body.userAddress, typedData: body.typedData, signature: body.signature },
      },
      SPONSORED,
    );
    return { status: 200, body: { transactionHash: txHashOf(result) } };
  } catch (err) {
    const failure = classifyPaymasterError(err, "execute");
    log.warn({ err, status: failure.status }, "sponsored invoke execute failed");
    return { status: failure.status, body: { error: failure.message, code: failure.code } };
  }
}

export type DeploymentBuildOutcome =
  | { status: 200; body: { typedData: unknown; deployment: unknown; calls: unknown[] } }
  | { status: 500 | 502 | 503 | 400 | 422; body: { error: string; code: string } };

export async function buildDeployment(
  deps: { clientFactory: () => PaymasterClient },
  body: { ownerPubkey: string; ownerAddress: string; salt?: string },
): Promise<DeploymentBuildOutcome> {
  const strk = getTokenBySymbol("STRK");
  if (!strk) return { status: 500, body: { error: "STRK token not found in registry", code: "sponsor_unavailable" } };

  const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
  if (!classHash) {
    return { status: 500, body: { error: "Media Wallet class hash is not configured", code: "sponsor_unavailable" } };
  }

  const calls = [
    {
      contractAddress: strk.address,
      entrypoint: "transfer",
      calldata: CallData.compile([body.ownerAddress, uint256.bnToUint256(0)]),
    },
  ];

  try {
    const prepared = (await deps.clientFactory().buildTransaction(
      {
        type: "deploy_and_invoke",
        deployment: {
          address: body.ownerAddress,
          class_hash: classHash,
          salt: body.salt ?? "0x0",
          calldata: ownerConstructorCalldata(body.ownerPubkey),
          version: 1,
        },
        invoke: {
          userAddress: body.ownerAddress,
          calls,
        },
      },
      SPONSORED,
    )) as { typed_data: unknown; deployment: unknown };

    return { status: 200, body: { typedData: prepared.typed_data, deployment: prepared.deployment, calls } };
  } catch (err) {
    const failure = classifyPaymasterError(err);
    log.warn({ err, status: failure.status }, "sponsored deploy build failed");
    return { status: failure.status, body: { error: failure.message, code: failure.code } };
  }
}

export default function paymaster(
  clientFactory: () => PaymasterClient = defaultClient,
  guard: MiddlewareHandler<AppEnv> = requireSession,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", guard);

  app.post("/invoke/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; calls?: unknown[] }
      | null;
    const outcome = await buildSponsoredInvoke({ clientFactory }, body ?? {});
    return c.json(outcome.body, outcome.status);
  });

  app.post("/invoke/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; typedData?: unknown; signature?: string[] }
      | null;
    const outcome = await executeSponsoredInvoke({ clientFactory }, body ?? {});
    return c.json(outcome.body, outcome.status);
  });

  app.post("/deploy/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerPubkey?: string; ownerAddress?: string; salt?: string }
      | null;
    if (!body?.ownerPubkey || !body.ownerAddress) {
      return c.json({ error: "ownerPubkey and ownerAddress are required", code: "invalid_request" }, 400);
    }

    const outcome = await buildDeployment({ clientFactory }, {
      ownerPubkey: body.ownerPubkey,
      ownerAddress: body.ownerAddress,
      salt: body.salt,
    });
    return c.json(outcome.body, outcome.status);
  });

  app.post("/deploy/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerAddress?: string; typedData?: unknown; signature?: string[]; deployment?: unknown }
      | null;
    if (!body?.ownerAddress || !body.typedData || !body.signature || !body.deployment) {
      return c.json({ error: "ownerAddress, typedData, signature and deployment are required", code: "invalid_request" }, 400);
    }
    try {
      const result = await clientFactory().executeTransaction(
        {
          type: "deploy_and_invoke",
          deployment: body.deployment,
          invoke: {
            userAddress: body.ownerAddress,
            typedData: body.typedData,
            signature: body.signature,
          },
        },
        SPONSORED,
      );
      return c.json({ transactionHash: txHashOf(result) });
    } catch (err) {
      const failure = classifyPaymasterError(err, "execute");
      log.warn({ err, status: failure.status }, "sponsored deploy execute failed");
      return c.json({ error: failure.message, code: failure.code }, failure.status);
    }
  });

  return app;
}
