import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";

export const DEFAULT_APP = "MEDIALANE_API";
export const IO_APP = "MEDIALANE_IO";

export function callerApp(c: Context<AppEnv>): string {
  return c.get("appId") ?? DEFAULT_APP;
}
