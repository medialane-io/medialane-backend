import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";
import { env } from "../config/env.js";

export function callerApiCreditsId(c: Context<AppEnv>): string | null {
  return c.get("apiKey")?.apiCredits?.id ?? null;
}

export function ioApiCreditsId(): string {
  if (!env.IO_CLIENT_ID) throw new Error("IO_CLIENT_ID is not configured");
  return env.IO_CLIENT_ID;
}
