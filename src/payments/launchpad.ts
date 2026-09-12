import { creditsForAction } from "./pricing.js";

export const TICKET_SERVICE = "ip-tickets";
export const MAX_RECIPIENTS_PER_RUN = 5000;

export interface QuoteLine {
  label: string;
  actionKey: string;
  units: number;
  unitCredits: number;
  credits: number;
}

export interface RunQuote {
  lines: QuoteLine[];
  totalCredits: number;
}

async function line(label: string, actionKey: string, units: number): Promise<QuoteLine> {
  const unitCredits = await creditsForAction(actionKey);
  return { label, actionKey, units, unitCredits, credits: unitCredits * units };
}

export async function quoteRun(service: string, recipients: number): Promise<RunQuote> {
  const people = `${recipients} ${recipients === 1 ? "person" : "people"}`;
  const lines: QuoteLine[] = [];

  if (service === TICKET_SERVICE) {
    lines.push(await line("Ticket type", "intent:create-tier", 1));
  }
  lines.push(await line(`Wallets for ${people}`, "wallet:deploy", recipients));
  lines.push(await line(`Assets for ${people}`, "intent:mint", recipients));

  return { lines, totalCredits: lines.reduce((sum, l) => sum + l.credits, 0) };
}
