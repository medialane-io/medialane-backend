import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";

export const BILLED_UNITS = "billedUnits";
export const BILLED_CREDITS = "billedCredits";

export function bill(c: Context<AppEnv>, units: number, credits?: number): void {
  c.set(BILLED_UNITS, Math.max(0, Math.trunc(units)));
  if (credits !== undefined) c.set(BILLED_CREDITS, Math.max(0, Math.trunc(credits)));
}

export function billedUnits(c: Context<AppEnv>, fallback: number): number {
  const declared = c.get(BILLED_UNITS);
  return typeof declared === "number" ? declared : fallback;
}

export function billedCredits(c: Context<AppEnv>): number | undefined {
  return c.get(BILLED_CREDITS);
}
