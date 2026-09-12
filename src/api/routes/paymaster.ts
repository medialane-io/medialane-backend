import { Hono } from "hono";
import { CallData, PaymasterRpc, hash, uint256 } from "starknet";
import { getTokenBySymbol, getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import { createLogger } from "../../utils/logger.js";
import { createContractAddressChecker, type ContractAddressChecker } from "./paymaster-contract-address.js";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:paymaster");

const AVNU_PAYMASTER_URL = "https://starknet.paymaster.avnu.fi";
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
    if (!(await checker.isEligible(call.entrypoint, call.contractAddress))) {
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

function defaultClient(): PaymasterClient {
  const apiKey = process.env.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) throw new Error("AVNU_PAYMASTER_API_KEY is not set");
  return new PaymasterRpc({
    nodeUrl: AVNU_PAYMASTER_URL,
    headers: { "x-paymaster-api-key": apiKey },
  }) as unknown as PaymasterClient;
}

export interface PaymasterErrorResult {
  status: 422 | 502 | 503;
  message: string;
}

export function classifyPaymasterError(err: unknown): PaymasterErrorResult {
  const text =
    err instanceof Error
      ? `${err.message}`
      : typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err ?? "");

  if (text.includes("AVNU_PAYMASTER_API_KEY")) {
    return { status: 503, message: "Gas sponsorship is not configured" };
  }

  if (text.includes("ENTRYPOINT_NOT_FOUND")) {
    return {
      status: 422,
      message: "The account is not deployed yet, so it cannot sign a sponsored transaction",
    };
  }

  if (text.includes("TRANSACTION_EXECUTION_ERROR") || text.includes("execution_error")) {
    return { status: 422, message: "The transaction could not be executed as submitted" };
  }

  return { status: 502, message: "Gas sponsorship is temporarily unavailable" };
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
  if (!classHash || deployment?.class_hash !== classHash || deployment?.address !== input.ownerAddress) {
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

export default function paymaster(
  clientFactory: () => PaymasterClient = defaultClient,
  addressChecker: ContractAddressChecker = createContractAddressChecker(prisma),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/invoke/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; calls?: unknown[] }
      | null;
    if (!body?.userAddress || !body.calls?.length) {
      return c.json({ error: "userAddress and a non-empty calls array are required" }, 400);
    }
    const disallowed = disallowedEntrypoint(body.calls);
    if (disallowed) {
      log.warn({ userAddress: body.userAddress, calls: body.calls, disallowed }, "sponsored invoke build: entrypoint not eligible");
      return c.json({ error: `Entrypoint "${disallowed}" is not eligible for sponsored gas` }, 400);
    }
    const disallowedAddress = await disallowedContractAddress(addressChecker, body.calls as SponsoredCall[]);
    if (disallowedAddress) {
      log.warn({ userAddress: body.userAddress, calls: body.calls, disallowedAddress }, "sponsored invoke build: contract not eligible");
      return c.json({ error: `Contract "${disallowedAddress}" is not eligible for sponsored gas` }, 400);
    }
    try {
      const prepared = (await clientFactory().buildTransaction(
        { type: "invoke", invoke: { userAddress: body.userAddress, calls: body.calls } },
        SPONSORED,
      )) as { typed_data: unknown };
      return c.json({ typedData: prepared.typed_data });
    } catch (err) {
      const failure = classifyPaymasterError(err);
      log.warn({ err, status: failure.status }, "sponsored invoke build failed");
      return c.json({ error: failure.message }, failure.status);
    }
  });

  app.post("/invoke/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; typedData?: unknown; signature?: string[]; calls?: unknown[] }
      | null;
    if (!body?.userAddress || !body.typedData || !body.signature || !body.calls?.length) {
      return c.json({ error: "userAddress, typedData, signature, and calls are required" }, 400);
    }
    const signed = signedCalls(body.typedData);
    if (signed.length === 0) {
      return c.json({ error: "typedData has no calls" }, 400);
    }

    const disallowed = disallowedEntrypoint(signed);
    if (disallowed) {
      log.warn({ userAddress: body.userAddress, signed, disallowed }, "sponsored invoke execute: entrypoint not eligible");
      return c.json({ error: `Entrypoint "${disallowed}" is not eligible for sponsored gas` }, 400);
    }
    const disallowedAddress = await disallowedContractAddress(addressChecker, signed as SponsoredCall[]);
    if (disallowedAddress) {
      log.warn({ userAddress: body.userAddress, signed, disallowedAddress }, "sponsored invoke execute: contract not eligible");
      return c.json({ error: `Contract "${disallowedAddress}" is not eligible for sponsored gas` }, 400);
    }
    try {
      assertTypedDataMatchesCalls(body.typedData, body.calls as SponsoredCall[]);
    } catch (err) {
      log.warn({ err, userAddress: body.userAddress }, "sponsored invoke execute: typedData does not match submitted calls");
      return c.json({ error: "typedData does not match the submitted calls" }, 400);
    }
    try {
      const result = await clientFactory().executeTransaction(
        {
          type: "invoke",
          invoke: { userAddress: body.userAddress, typedData: body.typedData, signature: body.signature },
        },
        SPONSORED,
      );
      return c.json({ transactionHash: txHashOf(result) });
    } catch (err) {
      const failure = classifyPaymasterError(err);
      log.warn({ err, status: failure.status }, "sponsored invoke execute failed");
      return c.json({ error: failure.message }, failure.status);
    }
  });

  app.post("/deploy/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerPubkey?: string; ownerAddress?: string; salt?: string }
      | null;
    if (!body?.ownerPubkey || !body.ownerAddress) {
      return c.json({ error: "ownerPubkey and ownerAddress are required" }, 400);
    }

    const strk = getTokenBySymbol("STRK");
    if (!strk) return c.json({ error: "STRK token not found in registry" }, 500);

    const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
    if (!classHash) return c.json({ error: "Media Wallet class hash is not configured" }, 500);

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
      return c.json({ error: failure.message }, failure.status);
    }
  });

  app.post("/deploy/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerAddress?: string; typedData?: unknown; signature?: string[]; deployment?: unknown; calls?: unknown[] }
      | null;
    if (!body?.ownerAddress || !body.typedData || !body.signature || !body.deployment || !body.calls?.length) {
      return c.json({ error: "ownerAddress, typedData, signature, deployment, and calls are required" }, 400);
    }

    const classHash = getCoordinates("STARKNET").mediaWalletClassHash;
    const deployment = body.deployment as { class_hash?: string; address?: string } | null;
    if (!classHash || deployment?.class_hash !== classHash || deployment?.address !== body.ownerAddress) {
      return c.json({ error: "deployment does not match a sponsorable Media Wallet deployment" }, 400);
    }

    const disallowed = disallowedEntrypoint(body.calls);
    if (disallowed) {
      return c.json({ error: `Entrypoint "${disallowed}" is not eligible for sponsored gas` }, 400);
    }
    const disallowedAddress = await disallowedContractAddress(addressChecker, body.calls as SponsoredCall[]);
    if (disallowedAddress) {
      return c.json({ error: `Contract "${disallowedAddress}" is not eligible for sponsored gas` }, 400);
    }
    try {
      assertTypedDataMatchesCalls(body.typedData, body.calls as SponsoredCall[]);
    } catch (err) {
      log.warn({ err, ownerAddress: body.ownerAddress }, "sponsored deploy execute: typedData does not match submitted calls");
      return c.json({ error: "typedData does not match the submitted calls" }, 400);
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
      const failure = classifyPaymasterError(err);
      log.warn({ err, status: failure.status }, "sponsored deploy execute failed");
      return c.json({ error: failure.message }, failure.status);
    }
  });

  return app;
}
