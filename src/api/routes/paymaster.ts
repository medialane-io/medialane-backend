import { Hono } from "hono";
import { CallData, PaymasterRpc, uint256 } from "starknet";
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

function defaultClient(): PaymasterClient {
  const apiKey = process.env.AVNU_PAYMASTER_API_KEY;
  if (!apiKey) throw new Error("AVNU_PAYMASTER_API_KEY is not set");
  return new PaymasterRpc({
    nodeUrl: AVNU_PAYMASTER_URL,
    headers: { "x-paymaster-api-key": apiKey },
  }) as unknown as PaymasterClient;
}

function txHashOf(result: unknown): string {
  return (result as { transaction_hash: string }).transaction_hash;
}

export default function paymaster(
  clientFactory: () => PaymasterClient = defaultClient,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/invoke/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; calls?: unknown[] }
      | null;
    if (!body?.userAddress || !body.calls?.length) {
      return c.json({ error: "userAddress and a non-empty calls array are required" }, 400);
    }
    try {
      const prepared = (await clientFactory().buildTransaction(
        { type: "invoke", invoke: { userAddress: body.userAddress, calls: body.calls } },
        SPONSORED,
      )) as { typed_data: unknown };
      return c.json({ typedData: prepared.typed_data });
    } catch (err) {
      log.warn({ err }, "sponsored invoke build failed");
      return c.json({ error: "Failed to build sponsored invoke transaction" }, 502);
    }
  });

  app.post("/invoke/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { userAddress?: string; typedData?: unknown; signature?: string[] }
      | null;
    if (!body?.userAddress || !body.typedData || !body.signature) {
      return c.json({ error: "userAddress, typedData, and signature are required" }, 400);
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
      log.warn({ err }, "sponsored invoke execute failed");
      return c.json({ error: "Failed to execute sponsored invoke transaction" }, 502);
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
            calls: [
              {
                contractAddress: strk.address,
                entrypoint: "transfer",
                calldata: CallData.compile([body.ownerAddress, uint256.bnToUint256(0)]),
              },
            ],
          },
        },
        SPONSORED,
      )) as { typed_data: unknown; deployment: unknown };
      return c.json({ typedData: prepared.typed_data, deployment: prepared.deployment });
    } catch (err) {
      log.warn({ err }, "sponsored deploy build failed");
      return c.json({ error: "Failed to build sponsored deploy transaction" }, 502);
    }
  });

  app.post("/deploy/execute", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ownerAddress?: string; typedData?: unknown; signature?: string[]; deployment?: unknown }
      | null;
    if (!body?.ownerAddress || !body.typedData || !body.signature || !body.deployment) {
      return c.json({ error: "ownerAddress, typedData, signature, and deployment are required" }, 400);
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
      log.warn({ err }, "sponsored deploy execute failed");
      return c.json({ error: "Failed to execute sponsored deploy transaction" }, 502);
    }
  });

  return app;
}
