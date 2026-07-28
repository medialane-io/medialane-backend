export interface PricingConfigRow {
  action: string;
  usd: number;
  chain?: string;
  service?: string;
  note?: string;
}

export const PRICING: PricingConfigRow[];
