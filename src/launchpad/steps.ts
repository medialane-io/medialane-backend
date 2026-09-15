export const RUN_BATCH_SIZE = 25;
export const MAX_RUN_ITEMS = 500;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type PriceOf = (action: string) => Promise<number>;

export interface StepCost {
  action: string;
  per: "step" | "item";
}

export type CostTable = Record<string, StepCost[]>;

export interface PlannedStep {
  kind: string;
  items: number;
}

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

export const GAS: StepCost[] = [
  { action: "paymaster:invoke-build", per: "step" },
  { action: "paymaster:invoke-execute", per: "step" },
];

function costsOf(table: CostTable, kind: string): StepCost[] {
  const costs = table[kind];
  if (!costs) throw new Error(`No cost is defined for the ${kind} step`);
  return costs;
}

const unitsOf = (cost: StepCost, step: PlannedStep) => (cost.per === "item" ? step.items : 1);

export async function creditsForStep(table: CostTable, step: PlannedStep, priceOf: PriceOf): Promise<number> {
  let total = 0;
  for (const cost of costsOf(table, step.kind)) total += (await priceOf(cost.action)) * unitsOf(cost, step);
  return total;
}

export async function quotePlan(table: CostTable, plan: PlannedStep[], priceOf: PriceOf): Promise<RunQuote> {
  const units = new Map<string, number>();
  for (const step of plan) {
    for (const cost of costsOf(table, step.kind)) {
      units.set(cost.action, (units.get(cost.action) ?? 0) + unitsOf(cost, step));
    }
  }
  const lines: QuoteLine[] = [];
  for (const [action, count] of units) {
    if (count === 0) continue;
    const unitCredits = await priceOf(action);
    lines.push({ action, units: count, unitCredits, credits: unitCredits * count });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.credits, 0) };
}

export function batchSizes(total: number): number[] {
  return Array.from({ length: Math.ceil(total / RUN_BATCH_SIZE) }, (_, i) =>
    Math.min(RUN_BATCH_SIZE, total - i * RUN_BATCH_SIZE),
  );
}
