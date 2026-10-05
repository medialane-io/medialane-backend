import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";
import { IO_APP } from "../apps/registry.js";
import { clientIdForApp } from "../apps/resolve.js";

export function callerClientId(c: Context<AppEnv>): string | null {
  return c.get("apiKey")?.apiClient?.id ?? null;
}

export async function ioClientId(): Promise<string> {
  const clientId = await clientIdForApp(IO_APP);
  if (!clientId) throw new Error(`The ${IO_APP} app is not bound to a client`);
  return clientId;
}
