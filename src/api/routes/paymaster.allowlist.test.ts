import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { ALLOWED_PAYMASTER_ENTRYPOINTS } from "./paymaster.js";
import { hasAddressRule } from "./paymaster-contract-address.js";

const INTENT_DIR = join(import.meta.dir, "../../orchestrator/intent");

// These read the chain for an ownership check before building a write call —
// they never end up in the `calls` array a client can ask us to sponsor, so
// they're not paymaster-eligible and are deliberately excluded here.
const READ_ONLY_ENTRYPOINTS = new Set(["owner", "is_collection_owner"]);

function entrypointsUsedByIntentBuilders(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(INTENT_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const text = readFileSync(join(INTENT_DIR, file), "utf8");
    for (const m of text.matchAll(/entrypoint:\s*"([a-zA-Z0-9_]+)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/\.populate\(\s*"([a-zA-Z0-9_]+)"/g)) found.add(m[1]);
  }
  for (const name of READ_ONLY_ENTRYPOINTS) found.delete(name);
  return found;
}

describe("paymaster entrypoint allowlist", () => {
  test("covers every write entrypoint orchestrator/intent/*.ts actually builds", () => {
    const used = entrypointsUsedByIntentBuilders();

    // Sanity check on the scan itself: if this ever comes back empty, the
    // regex stopped matching the source and the assertion below would pass
    // vacuously instead of catching drift.
    expect(used.size).toBeGreaterThan(0);

    const missing = [...used].filter((e) => !ALLOWED_PAYMASTER_ENTRYPOINTS.has(e));
    expect(missing).toEqual([]);
  });
});

describe("paymaster contract address allowlist", () => {
  test("every sponsorable entrypoint has a target-address rule defined", () => {
    const missing = [...ALLOWED_PAYMASTER_ENTRYPOINTS].filter((e) => !hasAddressRule(e));
    expect(missing).toEqual([]);
  });
});
