import { z } from "zod";
import { creditsForAction } from "../../payments/pricing.js";
import { creditsForStep, quotePlan, type PriceOf, type RunQuote } from "../steps.js";
import type { RunServiceDefinition } from "./shared-spec.js";
import { dataTokenization, type DataTokenizationSpec } from "./data-tokenization/definition.js";
import { ipTicketing, type IpTicketingSpec } from "./ip-ticketing/definition.js";

export const RUN_SERVICES = ["data-tokenization-erc721", "ip-ticketing"] as const;
export type RunService = (typeof RUN_SERVICES)[number];

export type RunSpec =
  | { service: "data-tokenization-erc721"; spec: DataTokenizationSpec }
  | { service: "ip-ticketing"; spec: IpTicketingSpec };

const DEFINITIONS: Record<RunService, RunServiceDefinition<unknown>> = {
  "data-tokenization-erc721": dataTokenization as unknown as RunServiceDefinition<unknown>,
  "ip-ticketing": ipTicketing as unknown as RunServiceDefinition<unknown>,
};

const defaultPriceOf: PriceOf = (action) => creditsForAction(action);

export function definitionOf(service: string): RunServiceDefinition<unknown> {
  const definition = DEFINITIONS[service as RunService];
  if (!definition) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["service"], message: `Unknown service ${service}` }]);
  }
  return definition;
}

export function parseRunSpec(service: string, raw: unknown): RunSpec {
  return { service, spec: definitionOf(service).parseSpec(raw) } as RunSpec;
}

export async function quoteRun(
  run: RunSpec,
  deps: { priceOf?: PriceOf; countProvisioned(guests: string[]): Promise<number> },
): Promise<RunQuote> {
  const definition = definitionOf(run.service);
  const guests = definition.guests(run.spec);
  const provisioned = guests.length > 0 ? await deps.countProvisioned(guests) : 0;
  return quotePlan(definition.costs, definition.plan(run.spec, { provisioned }), deps.priceOf ?? defaultPriceOf);
}

export function stepCredits(service: RunService, kind: string, items: number, priceOf: PriceOf): Promise<number> {
  return creditsForStep(definitionOf(service).costs, { kind, items }, priceOf);
}
