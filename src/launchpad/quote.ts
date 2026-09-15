import { creditsForAction } from "../payments/pricing.js";
import type { RunSpec } from "./run-spec.js";

export const RUN_BATCH_SIZE = 25;

export interface QuoteLine {
  action: string;
  units: number;
  unitCredits: number;
  credits: number;
}

export interface RunQuote {
  lines: QuoteLine[];
  total: number;
}

export interface QuoteDeps {
  priceOf(action: string): Promise<number>;
  countProvisioned(guests: string[]): Promise<number>;
}

const defaultDeps: Pick<QuoteDeps, "priceOf"> = {
  priceOf: (action) => creditsForAction(action),
};

function batches(calls: number): number {
  return Math.ceil(calls / RUN_BATCH_SIZE);
}

function unitsFor(run: RunSpec, provisioned: number): Array<[string, number]> {
  const newCollection = run.spec.collection.kind === "new" ? 1 : 0;

  if (run.service === "data-tokenization-erc721") {
    const covers = new Set(run.spec.items.flatMap((item) => (item.image ? [item.image.name] : [])));
    const mintBatches = batches(run.spec.items.length);
    const transactions = newCollection + mintBatches;
    return [
      ["intent:create-collection", newCollection],
      ["metadata:upload-file", run.spec.items.length + covers.size],
      ["metadata:upload-json", run.spec.items.length],
      ["intent:mint", run.spec.items.length],
      ["paymaster:invoke-build", transactions],
      ["paymaster:invoke-execute", transactions],
    ];
  }

  const guests = run.spec.guests.length;
  const newWallets = Math.max(0, guests - provisioned);
  const transactions = newCollection + 1 + batches(guests);
  return [
    ["intent:create-collection", newCollection],
    ["metadata:upload-file", run.spec.artwork ? 1 : 0],
    ["metadata:upload-json", 1],
    ["intent:create-tier", 1],
    ["wallet:deploy", newWallets],
    ["paymaster:deploy-build", newWallets],
    ["paymaster:deploy-execute", newWallets],
    ["issuance:emission", guests],
    ["paymaster:invoke-build", transactions],
    ["paymaster:invoke-execute", transactions],
  ];
}

export async function quoteRun(
  run: RunSpec,
  deps: Partial<QuoteDeps> & Pick<QuoteDeps, "countProvisioned">,
): Promise<RunQuote> {
  const priceOf = deps.priceOf ?? defaultDeps.priceOf;
  const provisioned = run.service === "ip-ticketing" ? await deps.countProvisioned(run.spec.guests) : 0;

  const lines: QuoteLine[] = [];
  for (const [action, units] of unitsFor(run, provisioned)) {
    if (units === 0) continue;
    const unitCredits = await priceOf(action);
    lines.push({ action, units, unitCredits, credits: unitCredits * units });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.credits, 0) };
}
