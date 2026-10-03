import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("who can have an account that expires", () => {
  test("a new account is ACTIVE unless something says otherwise, which is how provisioned accounts are created", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const account = schema.match(/model Account \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(account).toMatch(/status\s+AccountStatus\s+@default\(ACTIVE\)/);
  });

  test("only the email sign-up route ever marks an account PENDING, the state the 7-day rule closes", () => {
    const writers = sourceFiles(SRC)
      .filter((file) => /prisma\.account\.\w+\([\s\S]{0,200}?status:\s*"PENDING"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(writers).toEqual(["api/routes/auth-email.ts"]);
  });
});
