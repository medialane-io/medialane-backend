import { describe, expect, test } from "bun:test";
import { syncWalletActivity, type SyncDeps } from "./sync.js";
import { TRANSFER_SELECTOR, ACCOUNT_CREATED_GUID_SELECTOR, SUPPORTED_TOKENS, START_BLOCK } from "../config/constants.js";

const LATEST_BLOCK = START_BLOCK + 100;
import type { RawStarknetEvent } from "../types/starknet.js";

const ACCOUNT = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const CHAIN = "STARKNET" as const;

function fakeDeps(overrides: Partial<SyncDeps> = {}) {
  const upserted: Array<Record<string, unknown>> = [];
  let cursorSet: bigint | null = null;
  const deps: SyncDeps = {
    getCursor: async () => null,
    getLatestBlock: async () => LATEST_BLOCK,
    pollEvents: async () => [],
    getBlockTimestamp: async () => new Date("2026-01-01T00:00:00.000Z"),
    upsertActivities: async (rows) => { upserted.push(...rows); },
    setCursor: async (_chain, _address, block) => { cursorSet = block; },
    ...overrides,
  };
  return { deps, upserted, getCursorSet: () => cursorSet };
}

test("a fresh account (no cursor) syncs from START_BLOCK", async () => {
  let capturedFromBlock: number | undefined;
  const { deps } = fakeDeps({
    pollEvents: async (params) => { capturedFromBlock = params.fromBlock; return []; },
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(capturedFromBlock).toBe(START_BLOCK);
});

test("an existing cursor resumes from lastSyncedBlock + 1", async () => {
  let capturedFromBlock: number | undefined;
  const { deps } = fakeDeps({
    getCursor: async () => ({ lastSyncedBlock: 150n }),
    pollEvents: async (params) => { capturedFromBlock = params.fromBlock; return []; },
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(capturedFromBlock).toBe(151);
});

test("decodes a plain transfer into an upserted SEND row and advances the cursor", async () => {
  const token = SUPPORTED_TOKENS[0].address;
  const transferEvent: RawStarknetEvent = {
    block_hash: "0xb", block_number: 175, transaction_hash: "0xtx",
    from_address: token, keys: [TRANSFER_SELECTOR, ACCOUNT, "0xsomeone"], data: ["0x64", "0x0"],
  };
  const { deps, upserted, getCursorSet } = fakeDeps({
    pollEvents: async (params) => (params.address === token ? [transferEvent] : []),
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(upserted).toHaveLength(1);
  expect(upserted[0]).toMatchObject({ type: "SEND", tokenAddress: token, amount: "100", accountAddress: ACCOUNT });
  expect(getCursorSet()).toBe(BigInt(LATEST_BLOCK));
});

test("assigns each row's timestamp from its own block time, not wall-clock time", async () => {
  const token = SUPPORTED_TOKENS[0].address;
  const earlyEvent: RawStarknetEvent = {
    block_hash: "0xb1", block_number: 100, transaction_hash: "0xtx-early",
    from_address: token, keys: [TRANSFER_SELECTOR, ACCOUNT, "0xsomeone"], data: ["0x64", "0x0"],
  };
  const lateEvent: RawStarknetEvent = {
    block_hash: "0xb2", block_number: 200, transaction_hash: "0xtx-late",
    from_address: token, keys: [TRANSFER_SELECTOR, ACCOUNT, "0xsomeoneelse"], data: ["0x64", "0x0"],
  };
  const blockTimes: Record<number, Date> = {
    100: new Date("2026-01-01T00:00:00.000Z"),
    200: new Date("2026-06-01T00:00:00.000Z"),
  };
  const { deps, upserted } = fakeDeps({
    pollEvents: async (params) => (params.address === token ? [earlyEvent, lateEvent] : []),
    getBlockTimestamp: async (blockNumber) => blockTimes[blockNumber],
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);

  const early = upserted.find((r) => r.txHash === "0xtx-early");
  const late = upserted.find((r) => r.txHash === "0xtx-late");
  expect(early?.timestamp).toEqual(blockTimes[100]);
  expect(late?.timestamp).toEqual(blockTimes[200]);
});

test("decodes an account-contract event into a DEPLOY row", async () => {
  const deployEvent: RawStarknetEvent = {
    block_hash: "0xb", block_number: 175, transaction_hash: "0xtx2",
    from_address: ACCOUNT, keys: [ACCOUNT_CREATED_GUID_SELECTOR, "0xownerguid"], data: ["0x0"],
  };
  const { deps, upserted } = fakeDeps({
    pollEvents: async (params) => (params.address === ACCOUNT ? [deployEvent] : []),
  });
  await syncWalletActivity(deps, CHAIN, ACCOUNT);
  expect(upserted).toHaveLength(1);
  expect(upserted[0]).toMatchObject({ type: "DEPLOY", accountAddress: ACCOUNT, txHash: "0xtx2" });
});
