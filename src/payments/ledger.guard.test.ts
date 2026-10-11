import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

test("only the ledger changes a credit balance", () => {
  const writers = files(SRC).filter((path) => /creditBalance:\s*\{\s*(increment|decrement)/.test(readFileSync(path, "utf8")));
  expect(writers.map((path) => path.slice(SRC.length + 1))).toEqual(["payments/ledger.ts"]);
});
