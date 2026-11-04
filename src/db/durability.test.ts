import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Rows nothing can rebuild. Never deleted; guarded in the database. */
const RECORDS = [
  "Account", "Identity", "AccountProfile", "AccountEvent", "AccountNotice", "App",
  "ApiCredits", "ApiKey", "CreditEntry", "Payment", "FundingIntent", "LaunchpadRun",
  "TransactionIntent", "Comment", "Report", "RemixOffer", "UsernameClaim",
  "CollectionSlugClaim", "CollectionClaim", "CollectionProfile", "HiddenCreator",
];

/** Rows rebuilt by replaying on-chain events. Rewritten freely. */
const PROJECTIONS = [
  "IndexerCursor", "SourceCursor", "Order", "OrderFill", "Token", "Collection", "Coin",
  "WalletActivity", "WalletActivityCursor", "BlockTimestamp", "Transfer", "TokenBalance",
  "SponsorshipOffer", "SponsorshipBid", "SponsorshipProposal", "SponsorshipLicense",
  "UserScore", "UserBadge", "PointEvent", "Drop", "DropMint",
];

/** One-time codes that expire. Deleted once spent or expired. */
const SECRETS = ["SiwsNonce", "ClaimChallenge", "EmailVerificationCode"];

/** Migrations from this one on are held to the no-delete rule. */
const FIRST_CHECKED_MIGRATION = "20261104120000_records_are_never_deleted";

const root = join(import.meta.dir, "..", "..");
const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!);

const migrationsDir = join(root, "prisma", "migrations");
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, sql: readFileSync(join(migrationsDir, d.name, "migration.sql"), "utf8") }))
  .sort((a, b) => a.name.localeCompare(b.name));
const allSql = migrations.map((m) => m.sql).join("\n");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(path);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [path] : [];
  });
}

const lowerFirst = (s: string) => s[0]!.toLowerCase() + s.slice(1);

describe("data durability", () => {
  test("every model is exactly one of record, projection or secret", () => {
    const classified = [...RECORDS, ...PROJECTIONS, ...SECRETS];
    expect(new Set(classified).size).toBe(classified.length);
    expect(models.filter((m) => !classified.includes(m))).toEqual([]);
    expect(classified.filter((m) => !models.includes(m))).toEqual([]);
  });

  test("every record table is guarded against DELETE and TRUNCATE", () => {
    const guarded = [...allSql.matchAll(/SELECT "guard_record_table"\('(\w+)'\);/g)].map((m) => m[1]!);
    expect(RECORDS.filter((r) => !guarded.includes(r))).toEqual([]);
  });

  test("no relation from a record cascades or sets null on delete", () => {
    for (const r of RECORDS) {
      const body = schema.match(new RegExp(`^model ${r} \\{([\\s\\S]*?)^\\}`, "m"))![1]!;
      expect({ model: r, cascades: /onDelete: (Cascade|SetNull)/.test(body) }).toEqual({ model: r, cascades: false });
    }
  });

  test("no migration from the guard on deletes, truncates or drops record data", () => {
    const checked = migrations.filter((m) => m.name >= FIRST_CHECKED_MIGRATION);
    expect(checked.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { name, sql } of checked) {
      const archives = /CREATE TABLE\s+"?archive"?\./i.test(sql);
      if (/DROP\s+TRIGGER/i.test(sql)) problems.push(`${name}: drops a trigger`);
      if (/DROP\s+FUNCTION\s+"?(refuse_record_delete|guard_record_table)/i.test(sql)) problems.push(`${name}: drops the guard`);
      for (const r of RECORDS) {
        const t = `"?${r}"?(?![\\w"])`;
        if (new RegExp(`DELETE\\s+FROM\\s+${t}`, "i").test(sql)) problems.push(`${name}: deletes from ${r}`);
        if (new RegExp(`TRUNCATE[^;]*${t}`, "i").test(sql)) problems.push(`${name}: truncates ${r}`);
        if (new RegExp(`DROP\\s+TABLE[^;]*${t}`, "i").test(sql)) problems.push(`${name}: drops ${r}`);
        if (!archives && new RegExp(`ALTER\\s+TABLE\\s+${t}[^;]*DROP\\s+COLUMN`, "i").test(sql)) {
          problems.push(`${name}: drops a ${r} column without copying it to archive`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("no code deletes from a record table", () => {
    const problems: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      const code = readFileSync(file, "utf8");
      for (const r of RECORDS) {
        if (new RegExp(`\\.${lowerFirst(r)}\\.(delete|deleteMany)\\(`).test(code)) problems.push(`${file}: deletes ${r}`);
        if (new RegExp(`(DELETE\\s+FROM|TRUNCATE)\\s+"${r}"`, "i").test(code)) problems.push(`${file}: deletes ${r} in SQL`);
      }
    }
    expect(problems).toEqual([]);
  });
});
