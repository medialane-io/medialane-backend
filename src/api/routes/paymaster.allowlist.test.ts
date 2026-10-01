import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  buildAddOwnerCall,
  buildCancelEscapeCall,
  buildCompleteEscapeOwnerCall,
  buildRemoveOwnerCall,
  buildSetFirstGuardianCall,
  buildTriggerEscapeOwnerCall,
} from "@medialane/sdk/starknet";
import { ALLOWED_PAYMASTER_ENTRYPOINTS, disallowedContractAddress, disallowedEntrypoint } from "./paymaster.js";

const INTENT_DIR = join(import.meta.dir, "../../orchestrator/intent");

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

    expect(used.size).toBeGreaterThan(0);

    const missing = [...used].filter((e) => !ALLOWED_PAYMASTER_ENTRYPOINTS.has(e));
    expect(missing).toEqual([]);
  });
});

describe("a wallet managing itself", () => {
  const wallet = "0x071c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f";
  const other = "0x03a90664ef86880dbe6bf9c6c8f874177944a3e48b40463e8de60bcb3d4790f5";
  const checker = { isEligible: async () => false };
  const calls = [
    buildAddOwnerCall(wallet, "0x0123"),
    buildRemoveOwnerCall(wallet, "0x0123"),
    buildSetFirstGuardianCall(wallet, "0x0456"),
    buildTriggerEscapeOwnerCall(wallet, "0x0789"),
    buildCompleteEscapeOwnerCall(wallet),
    buildCancelEscapeCall(wallet),
  ].map((call) => ({ ...call, calldata: call.calldata ?? [] }));

  test("every device and recovery call the wallet makes is a sponsored entrypoint", () => {
    expect(disallowedEntrypoint(calls)).toBeNull();
  });

  test("the wallet may call itself, written padded or not", async () => {
    expect(await disallowedContractAddress(checker, calls, wallet)).toBeNull();
    expect(await disallowedContractAddress(checker, calls, "0x71c174b93d24b72fc4b25e1d28fce1267e30c4c57fa4b0980a403a97fa84f5f")).toBeNull();
  });

  test("another wallet may not call it", async () => {
    expect(await disallowedContractAddress(checker, calls, other)).toBe(calls[0]!.contractAddress);
  });
});
