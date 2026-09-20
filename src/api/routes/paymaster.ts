import { Hono } from "hono";
import { CallData, PaymasterRpc, hash, uint256 } from "starknet";
import { getTokenBySymbol, getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import { createLogger } from "../../utils/logger.js";
import { createContractAddressChecker, type ContractAddressChecker } from "./paymaster-contract-address.js";
import { createSponsorAuthorizer, type SponsorAuthorizer } from "./sponsor-authorizer.js";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:paymaster");

const AVNU_PAYMASTER_URL = "https://starknet.paymaster.avnu.fi";

const STRK_WEI = 10n ** 18n;
const DEFAULT_MAX_SPONSORED_FEE_STRK = 0.5;

export function maxSponsoredFeeWei(): bigint {
  const configured = Number(process.env.MAX_SPONSORED_FEE_STRK);
  const strk = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_SPONSORED_FEE_STRK;
  return BigInt(Math.round(strk * 1e9)) * (STRK_WEI / 10n ** 9n);
}

export function sponsoredFeeWei(prepared: unknown): bigint | null {
  const fee = (prepared as { fee?: { suggested_max_fee_in_strk?: unknown } } | null)?.fee;
  if (fee?.suggested_max_fee_in_strk === undefined) return null;
  try {
    return BigInt(fee.suggested_max_fee_in_strk as string);
  } catch {
    return null;
  }
}
const SPONSORED = { version: "0x1", feeMode: { mode: "sponsored" } } as const;

export const ALLOWED_PAYMASTER_ENTRYPOINTS = new Set([
  "approve",
  "transfer",
  "set_approval_for_all",
  "register_order",
  "fulfill_order",
  "cancel_order",
  "mint",
  "mint_edition",
  "create_collection",
  "deploy_collection",
  "create_drop",
  "create_ticket",
  "create_membership",
  "create_offer",
  "set_offer_open",
  "place_bid",
  "retract_bid",
  "accept_bid",
  "propose_sponsorship",
  "withdraw_proposal",
  "accept_proposal",
  "reject_proposal",
  "create_creator_coin",
  "launch_on_ekubo",
  "add_comment",
  "claim",
  "batch_add_to_allowlist",
  "remove_from_allowlist",
  "set_allowlist_enabled",
  "withdraw_payments",
  "transfer_collection_ownership",
  "transfer_from",
  "safe_transfer_from",
  "mint_item",
]);

interface SponsoredCall {
  contractAddress: string;
  entrypoint: string;
  calldata: unknown;
}

function isSponsoredCall(value: unknown): value is SponsoredCall {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SponsoredCall).contractAddress === "string" &&
    typeof (value as SponsoredCall).entrypoint === "string"
  );
}

function isZero(value: unknown): boolean {
  try {
    return BigInt(value as string) === 0n;
  } catch {
    return false;
  }
}

function sameFelt(a: unknown, b: unknown): boolean {
  try {
    return BigInt(a as string) === BigInt(b as string);
  } catch {
    return false;
  }
}

let selectorsByName: Map<string, string> | null = null;

function entrypointForSelector(selector: unknown): string | null {
  if (!selectorsByName) {
    selectorsByName = new Map();
    for (const name of ALLOWED_PAYMASTER_ENTRYPOINTS) {
      selectorsByName.set(BigInt(hash.getSelectorFromName(name)).toString(), name);
    }
  }
  try {
    return selectorsByName.get(BigInt(selector as string).toString()) ?? null;
  } catch {
    return null;
  }
}

export function signedCalls(typedData: unknown): Array<{ contractAddress: string; entrypoint: string }> {
  const message = (typedData as { message?: Record<string, unknown> } | null)?.message;
  const raw = message ? (("calls" in message ? message.calls : message.Calls) as unknown) : undefined;
  if (!Array.isArray(raw)) return [];

  const calls: Array<{ contractAddress: string; entrypoint: string }> = [];
  for (const entry of raw) {
    const call = entry as Record<string, unknown>;
    const to = call.To ?? call.to;
    const selector = call.Selector ?? call.selector;

    if (isZero(to) && isZero(selector)) continue;

    const entrypoint = entrypointForSelector(selector);
    calls.push({
      contractAddress: typeof to === "string" ? to : "",
      entrypoint: entrypoint ?? `unknown selector ${String(selector)}`,
    });
  }
  return calls;
}

export function disallowedEntrypoint(calls: unknown[]): string | null {
  for (const call of calls) {
    if (!isSponsoredCall(call)) return "invalid call";
    if (!ALLOWED_PAYMASTER_ENTRYPOINTS.has(call.entrypoint)) return call.entrypoint;
  }
  return null;
}

export async function disallowedContractAddress(
  checker: ContractAddressChecker,
  calls: SponsoredCall[],
): Promise<string | null> {
  for (const call of calls) {
    if (!(await checker.isEligible(call.contractAddress))) {
      return call.contractAddress;
    }
  }
  return null;
}

export function assertTypedDataMatchesCalls(typedData: unknown, calls: SponsoredCall[]): void {
  const message = (typedData as { message?: Record<string, unknown> } | null)?.message;
  const unsafeCalls = message ? (("calls" in message ? message.calls : message.Calls) as unknown) : undefined;
  if (!Array.isArray(unsafeCalls) || unsafeCalls.length < calls.length) {
    throw new Error(`typedData has ${Array.isArray(unsafeCalls) ? unsafeCalls.length : 0} calls, expected at least ${calls.length}`);
  }

  calls.forEach((call, i) => {
    const unsafe = unsafeCalls[i] as Record<string, unknown>;
    const to = unsafe.To ?? unsafe.to;
    const selector = unsafe.Selector ?? unsafe.selector;
    const calldata = (unsafe.Calldata ?? unsafe.calldata) as unknown[];

    if (to === undefined || BigInt(to as string) !== BigInt(call.contractAddress)) {
      throw new Error(`typedData call ${i}: contract address mismatch`);
    }
    if (selector === undefined || BigInt(selector as string) !== BigInt(hash.getSelectorFromName(call.entrypoint))) {
      throw new Error(`typedData call ${i}: entrypoint mismatch`);
    }
    const expectedCalldata = CallData.toCalldata(call.calldata as never);
    const calldataMatches =
      Array.isArray(calldata) &&
      calldata.length === expectedCalldata.length &&
      calldata.every((v, j) => BigInt(v as string) === BigInt(expectedCalldata[j]!));
    if (!calldataMatches) {
      throw new Error(`typedData call ${i}: calldata mismatch`);
    }
  });
}

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
  | "not_eligible"
  | "not_authorized"
  | "rate_limited"
  | "too_expensive"
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

function txHashOf(result: unknown): string {
  return (result as { transaction_hash: string }).transaction_hash;
}

export async function executeSponsoredDeploy(
  input: { ownerAddress: string; typedData: unknown; signature: string[]; deployment: unknown },
  clientFactory: () => PaymasterClient = defaultClient,
): Promise<string> {
  const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
  const deployment = input.deployment as { class_hash?: string; address?: string } | null;
  if (!classHash || !sameFelt(deployment?.class_hash, classHash) || !sameFelt(deployment?.address, input.ownerAddress)) {
    throw new Error("deployment does not match a sponsorable Media Wallet deployment");
  }
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

export interface SponsoredInvokeDeps {
  clientFactory: () => PaymasterClient;
  addressChecker: ContractAddressChecker;
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
  const disallowed = disallowedEntrypoint(body.calls);
  if (disallowed) {
    log.warn({ userAddress: body.userAddress, calls: body.calls, disallowed }, "sponsored invoke build: entrypoint not eligible");
    return { status: 400, body: { error: `Entrypoint "${disallowed}" is not eligible for sponsored gas`, code: "not_eligible" } };
  }
  const disallowedAddress = await disallowedContractAddress(deps.addressChecker, body.calls as SponsoredCall[]);
  if (disallowedAddress) {
    log.warn({ userAddress: body.userAddress, calls: body.calls, disallowedAddress }, "sponsored invoke build: contract not eligible");
    return { status: 400, body: { error: `Contract "${disallowedAddress}" is not eligible for sponsored gas`, code: "not_eligible" } };
  }
  try {
    const prepared = (await deps.clientFactory().buildTransaction(
      { type: "invoke", invoke: { userAddress: body.userAddress, calls: body.calls } },
      SPONSORED,
    )) as { typed_data: unknown };

    const feeWei = sponsoredFeeWei(prepared);
    const capWei = maxSponsoredFeeWei();
    if (feeWei !== null && feeWei > capWei) {
      log.error(
        { userAddress: body.userAddress, calls: body.calls, feeWei: feeWei.toString(), capWei: capWei.toString() },
        "sponsored invoke build: over the per-transaction gas ceiling",
      );
      return {
        status: 400,
        body: { error: "This transaction costs more gas than Medialane sponsors in one go", code: "too_expensive" },
      };
    }
    log.info(
      { userAddress: body.userAddress, feeWei: feeWei === null ? null : feeWei.toString() },
      "sponsored invoke built",
    );

    return { status: 200, body: { typedData: prepared.typed_data } };
  } catch (err) {
    const failure = classifyPaymasterError(err);
    log.warn({ err, status: failure.status }, "sponsored invoke build failed");
    return { status: failure.status, body: { error: failure.message, code: failure.code } };
  }
}

export async function exceedsGasCeiling(
  deps: SponsoredInvokeDeps,
  userAddress: string,
  calls: SponsoredCall[],
): Promise<{ feeWei: string; capWei: string } | null> {
  let prepared: unknown;
  try {
    prepared = await deps.clientFactory().buildTransaction({ type: "invoke", invoke: { userAddress, calls } }, SPONSORED);
  } catch {
    return null;
  }
  const feeWei = sponsoredFeeWei(prepared);
  const capWei = maxSponsoredFeeWei();
  return feeWei !== null && feeWei > capWei ? { feeWei: feeWei.toString(), capWei: capWei.toString() } : null;
}

export async function executeSponsoredInvoke(
  deps: SponsoredInvokeDeps,
  body: { userAddress?: string; typedData?: unknown; signature?: string[]; calls?: unknown[] },
): Promise<SponsoredOutcome> {
  if (!body.userAddress || !body.typedData || !body.signature || !body.calls?.length) {
    return { status: 400, body: { error: "userAddress, typedData, signature, and calls are required", code: "invalid_request" } };
  }
  const signed = signedCalls(body.typedData);
  if (signed.length === 0) {
    return { status: 400, body: { error: "typedData has no calls", code: "invalid_request" } };
  }

  const disallowed = disallowedEntrypoint(signed);
  if (disallowed) {
    log.warn({ userAddress: body.userAddress, signed, disallowed }, "sponsored invoke execute: entrypoint not eligible");
    return { status: 400, body: { error: `Entrypoint "${disallowed}" is not eligible for sponsored gas`, code: "not_eligible" } };
  }
  const disallowedAddress = await disallowedContractAddress(deps.addressChecker, signed as SponsoredCall[]);
  if (disallowedAddress) {
    log.warn({ userAddress: body.userAddress, signed, disallowedAddress }, "sponsored invoke execute: contract not eligible");
    return { status: 400, body: { error: `Contract "${disallowedAddress}" is not eligible for sponsored gas`, code: "not_eligible" } };
  }
  try {
    assertTypedDataMatchesCalls(body.typedData, body.calls as SponsoredCall[]);
  } catch (err) {
    log.warn({ err, userAddress: body.userAddress }, "sponsored invoke execute: typedData does not match submitted calls");
    return { status: 400, body: { error: "typedData does not match the submitted calls", code: "invalid_request" } };
  }
  const overCeiling = await exceedsGasCeiling(deps, body.userAddress, body.calls as SponsoredCall[]);
  if (overCeiling) {
    log.error(
      { userAddress: body.userAddress, calls: body.calls, ...overCeiling },
      "sponsored invoke execute: over the per-transaction gas ceiling",
    );
    return {
      status: 400,
      body: { error: "This transaction costs more gas than Medialane sponsors in one go", code: "too_expensive" },
    };
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

export default function paymaster(
  clientFactory: () => PaymasterClient = defaultClient,
  addressChecker: ContractAddressChecker = createContractAddressChecker(prisma),
  authorizer: SponsorAuthorizer = createSponsorAuthorizer(prisma),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/invoke/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; calls?: unknown[] }
      | null;
    const denied = await authorizer.authorize({
      sessionToken: c.req.header("x-account-session"),
      apiKeyAccountId: c.get("account")?.id,
      userAddress: body?.userAddress,
    });
    if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    const outcome = await buildSponsoredInvoke({ clientFactory, addressChecker }, body ?? {});
    return c.json(outcome.body, outcome.status);
  });

  app.post("/invoke/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; typedData?: unknown; signature?: string[]; calls?: unknown[] }
      | null;
    const denied = await authorizer.authorize({
      sessionToken: c.req.header("x-account-session"),
      apiKeyAccountId: c.get("account")?.id,
      userAddress: body?.userAddress,
    });
    if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    const outcome = await executeSponsoredInvoke({ clientFactory, addressChecker }, body ?? {});
    return c.json(outcome.body, outcome.status);
  });

  app.post("/deploy/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerPubkey?: string; ownerAddress?: string; salt?: string }
      | null;
    const denied = await authorizer.authorize({
      sessionToken: c.req.header("x-account-session"),
      apiKeyAccountId: c.get("account")?.id,
    });
    if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    if (!body?.ownerPubkey || !body.ownerAddress) {
      return c.json({ error: "ownerPubkey and ownerAddress are required", code: "invalid_request" }, 400);
    }

    const strk = getTokenBySymbol("STRK");
    if (!strk) return c.json({ error: "STRK token not found in registry", code: "sponsor_unavailable" }, 500);

    const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
    if (!classHash) return c.json({ error: "Media Wallet class hash is not configured", code: "sponsor_unavailable" }, 500);

    const calls = [
      {
        contractAddress: strk.address,
        entrypoint: "transfer",
        calldata: CallData.compile([body.ownerAddress, uint256.bnToUint256(0)]),
      },
    ];

    try {
      const prepared = (await clientFactory().buildTransaction(
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

      return c.json({ typedData: prepared.typed_data, deployment: prepared.deployment, calls });
    } catch (err) {
      const failure = classifyPaymasterError(err);
      log.warn({ err, status: failure.status }, "sponsored deploy build failed");
      return c.json({ error: failure.message, code: failure.code }, failure.status);
    }
  });

  app.post("/deploy/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerAddress?: string; typedData?: unknown; signature?: string[]; deployment?: unknown; calls?: unknown[] }
      | null;
    const denied = await authorizer.authorize({
      sessionToken: c.req.header("x-account-session"),
      apiKeyAccountId: c.get("account")?.id,
    });
    if (denied) return c.json({ error: denied.error, code: denied.code }, denied.status);
    if (!body?.ownerAddress || !body.typedData || !body.signature || !body.deployment || !body.calls?.length) {
      return c.json({ error: "ownerAddress, typedData, signature, deployment, and calls are required", code: "invalid_request" }, 400);
    }

    const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
    const deployment = body.deployment as { class_hash?: string; address?: string } | null;
    if (!classHash || !sameFelt(deployment?.class_hash, classHash) || !sameFelt(deployment?.address, body.ownerAddress)) {
      return c.json({ error: "deployment does not match a sponsorable Media Wallet deployment", code: "not_eligible" }, 400);
    }

    const disallowed = disallowedEntrypoint(body.calls);
    if (disallowed) {
      return c.json({ error: `Entrypoint "${disallowed}" is not eligible for sponsored gas`, code: "not_eligible" }, 400);
    }
    const disallowedAddress = await disallowedContractAddress(addressChecker, body.calls as SponsoredCall[]);
    if (disallowedAddress) {
      return c.json({ error: `Contract "${disallowedAddress}" is not eligible for sponsored gas`, code: "not_eligible" }, 400);
    }
    try {
      assertTypedDataMatchesCalls(body.typedData, body.calls as SponsoredCall[]);
    } catch (err) {
      log.warn({ err, ownerAddress: body.ownerAddress }, "sponsored deploy execute: typedData does not match submitted calls");
      return c.json({ error: "typedData does not match the submitted calls", code: "invalid_request" }, 400);
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
