import prismaDefault from "../db/client.js";
import type { Prisma } from "@prisma/client";
import type { Context } from "hono";
import type { AppEnv } from "../types/hono.js";

export const BILLED_UNITS = "billedUnits";

export interface UsageDb {
  usageEvent: { create(args: Prisma.UsageEventCreateArgs): Promise<unknown> };
}

export interface UsageRecord {
  apiClientId: string;
  actionKey: string;
  chain: string;
  service: string;
  unitCredits: number;
  units: number;
  credits: number;
  method: string;
  path: string;
  status: number;
}

export function bill(c: Context<AppEnv>, units: number): void {
  c.set(BILLED_UNITS, Math.max(0, Math.trunc(units)));
}

export function billedUnits(c: Context<AppEnv>, fallback: number): number {
  const declared = c.get(BILLED_UNITS);
  return typeof declared === "number" ? declared : fallback;
}

export async function recordUsage(
  record: UsageRecord,
  db: UsageDb = prismaDefault as unknown as UsageDb,
): Promise<void> {
  await db.usageEvent.create({ data: record });
}

export function drift(credited: number, spent: number, balance: number): number {
  return balance - (credited - spent);
}
