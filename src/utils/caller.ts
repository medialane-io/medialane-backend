import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";

export function callerClientId(c: Context<AppEnv>): string | null {
  return c.get("apiKey")?.apiClient?.id ?? null;
}
