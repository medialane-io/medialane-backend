import { creditsForAction } from "./pricing.js";
import { x402Config } from "../config/x402.js";

export const TICKET_SERVICE = "ip-tickets";
export const MAX_RECIPIENTS_PER_RUN = 5000;

export interface QuoteLine {
  label: string;
  credits: number;
}

export interface RunQuote {
  lines: QuoteLine[];
  totalCredits: number;
  totalAtomic: string;
}

export async function quoteRun(service: string, recipients: number): Promise<RunQuote> {
  const lines: QuoteLine[] = [];

  if (service === TICKET_SERVICE) {
    lines.push({ label: "Ticket type", credits: await creditsForAction("intent:create-tier") });
  }

  const people = `${recipients} ${recipients === 1 ? "person" : "people"}`;
  lines.push({
    label: `Wallets for ${people}`,
    credits: (await creditsForAction("wallet:deploy")) * recipients,
  });
  lines.push({
    label: `Assets for ${people}`,
    credits: (await creditsForAction("intent:mint")) * recipients,
  });

  const totalCredits = lines.reduce((sum, l) => sum + l.credits, 0);
  return {
    lines,
    totalCredits,
    totalAtomic: (BigInt(totalCredits) * x402Config.usdcAtomicPerCredit).toString(),
  };
}
