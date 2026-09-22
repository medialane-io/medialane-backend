import { readFileSync } from "node:fs";
import prisma from "../src/db/client.js";
import { IDENTITY_SCHEME } from "../src/utils/identity.js";
import {
  planClerkEmailBackfill,
  normalizeIdentityValue,
  type BackfillOutcome,
  type ClerkRow,
} from "../src/scripts/clerk-email-backfill.js";

const DRY_RUN = process.env.DRY_RUN !== "false";
const MARK_VERIFIED = process.env.MARK_VERIFIED === "true";
const file = process.argv[2];

if (!file) {
  console.error("usage: bun run scripts/backfill-clerk-emails.ts <clerk-export.csv>");
  process.exit(1);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseClerkCsv(text: string): ClerkRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idCol = header.findIndex((h) => h === "id" || h === "user_id");
  const emailCol = header.findIndex((h) => h.includes("email"));

  if (idCol === -1 || emailCol === -1) {
    throw new Error(`could not find id and email columns in header: ${header.join(", ")}`);
  }

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return { clerkUserId: cells[idCol] ?? "", email: cells[emailCol] ?? "" };
  });
}

const rows = parseClerkCsv(readFileSync(file, "utf8"));
console.log(`read ${rows.length} rows from ${file}`);

const clerkRows = await prisma.identity.findMany({
  where: { scheme: IDENTITY_SCHEME.CLERK, value: { not: null } },
  select: { value: true, accountId: true, tenantId: true },
});
const clerkIdentities = new Map(
  clerkRows.map((r) => [r.value!, { accountId: r.accountId, tenantId: r.tenantId }]),
);

const emailRows = await prisma.identity.findMany({
  where: { scheme: IDENTITY_SCHEME.EMAIL, value: { not: null } },
  select: { value: true, accountId: true },
});
const emailOwners = new Map(
  emailRows.map((r) => [normalizeIdentityValue("email", r.value!), r.accountId]),
);

console.log(`database has ${clerkIdentities.size} clerk identities, ${emailOwners.size} email identities`);

const outcomes = planClerkEmailBackfill(rows, clerkIdentities, emailOwners);
const by = (kind: BackfillOutcome["kind"]) => outcomes.filter((o) => o.kind === kind);

const creates = by("create") as Extract<BackfillOutcome, { kind: "create" }>[];
const conflicts = by("conflict") as Extract<BackfillOutcome, { kind: "conflict" }>[];

console.log(`\n  create          ${creates.length}`);
console.log(`  already linked  ${by("already_linked").length}`);
console.log(`  conflict        ${conflicts.length}`);
console.log(`  unmatched       ${by("unmatched").length}`);
console.log(`  skipped rows    ${rows.length - outcomes.length}`);

if (conflicts.length > 0) {
  console.log(`\nconflicts (email already on a different account, left untouched):`);
  for (const c of conflicts) {
    console.log(`  ${c.email} -> clerk account ${c.clerkAccountId}, existing ${c.otherAccountId}`);
  }
}

if (DRY_RUN) {
  console.log(`\ndry run, nothing written. re-run with DRY_RUN=false to apply.`);
  await prisma.$disconnect();
  process.exit(0);
}

let written = 0;
for (const c of creates) {
  await prisma.identity.create({
    data: {
      accountId: c.accountId,
      scheme: IDENTITY_SCHEME.EMAIL,
      value: c.email,
      email: c.email,
      tenantId: c.tenantId,
      verifiedAt: MARK_VERIFIED ? new Date() : null,
    },
  });
  written += 1;
}

console.log(`\nwrote ${written} email identities${MARK_VERIFIED ? " (marked verified)" : ""}`);
await prisma.$disconnect();
