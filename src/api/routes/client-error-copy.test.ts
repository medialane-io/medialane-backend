import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(import.meta.dir);

const EXCEPTION_DERIVED = /\btoErrorMessage\s*\(|\berr\b|\be\.message\b|\.stack\b|\bfailReason\b/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    if (!entry.endsWith(".ts") || entry.includes(".test.")) return [];
    return [full];
  });
}

function errorPayloads(source: string): string[] {
  const found: string[] = [];
  const marker = /\berror:\s*/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    let depth = 0;
    let quote: string | null = null;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if ("([{".includes(ch)) { depth++; continue; }
      if (")]}".includes(ch)) { if (depth === 0) break; depth--; continue; }
      if (ch === "," && depth === 0) break;
    }
    found.push(source.slice(start, i).trim());
  }
  return found;
}

test("no route returns exception text to the client", () => {
  const offenders: string[] = [];
  for (const file of routeFiles(ROUTES_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const payload of errorPayloads(source)) {
      if (EXCEPTION_DERIVED.test(payload)) {
        offenders.push(`${file.replace(ROUTES_DIR, "routes")}: error: ${payload}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the scanner reads an error payload without stopping at a nested brace", () => {
  expect(errorPayloads('c.json({ error: `Intent is ${intent.status}` }, 409)')).toEqual([
    "`Intent is ${intent.status}`",
  ]);
  expect(errorPayloads('c.json({ error: toErrorMessage(err) }, 500)')).toEqual(["toErrorMessage(err)"]);
  expect(errorPayloads('if (err.code === "X") return c.json({ error: "Limit reached" }, 409)')).toEqual([
    '"Limit reached"',
  ]);
});
