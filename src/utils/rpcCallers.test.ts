import { afterEach, describe, expect, test } from "bun:test";
import { hash } from "starknet";
import { STARKNET_MARKETPLACE_721_CONTRACT } from "../config/constants.js";
import { normalizeAddress } from "./starknet.js";
import {
  checkOnChainOrderCancelled,
  fetchMarketplaceReceiptEvents,
  fetchTransactionOwnership,
} from "./txVerifier.js";
import { fetchCounter, fetchRoyaltyMaxBps } from "../orchestrator/intent/shared.js";

type RpcBody = { id: number; method: string; params: Record<string, unknown> };

const realFetch = globalThis.fetch;
const sent: RpcBody[] = [];

function node(answer: (body: RpcBody) => { result?: unknown; error?: { code: number; message: string } }) {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcBody;
    sent.push(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer(body) }), { status: 200 });
  }) as typeof fetch;
}

const NOT_FOUND = { error: { code: 29, message: "Transaction hash not found" } };

afterEach(() => {
  globalThis.fetch = realFetch;
  sent.length = 0;
});

describe("transaction receipts", () => {
  test("a receipt the node does not have yet reads as no events", async () => {
    node(() => NOT_FOUND);
    expect(await fetchMarketplaceReceiptEvents("0xabc")).toEqual([]);
    expect(sent[0]!.method).toBe("starknet_getTransactionReceipt");
  });

  test("marketplace events come back from the raw receipt", async () => {
    const marketplace = normalizeAddress("STARKNET", STARKNET_MARKETPLACE_721_CONTRACT);
    node(() => ({
      result: {
        block_number: 12,
        block_hash: "0xb10c",
        events: [
          { from_address: marketplace, keys: ["0x1"], data: ["0x2"] },
          { from_address: "0x999", keys: ["0x3"], data: [] },
        ],
      },
    }));
    const events = await fetchMarketplaceReceiptEvents("0xabc");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from_address: marketplace, keys: ["0x1"], data: ["0x2"], block_number: 12, block_hash: "0xb10c" });
  });
});

describe("transaction ownership", () => {
  test("reads the sender and calldata of the transaction", async () => {
    node(() => ({ result: { sender_address: "0xa11ce", calldata: ["0x1", "0x2"] } }));
    expect(await fetchTransactionOwnership("0xabc")).toEqual({ sender: "0xa11ce", calldata: ["0x1", "0x2"] });
    expect(sent[0]!.method).toBe("starknet_getTransactionByHash");
  });

  test("an unknown transaction has no sender", async () => {
    node(() => NOT_FOUND);
    expect(await fetchTransactionOwnership("0xabc")).toEqual({ sender: null, calldata: null });
  });
});

describe("marketplace contract reads", () => {
  test("an order whose status is 3 is cancelled", async () => {
    const result = Array.from({ length: 15 }, () => "0x0");
    result[14] = "0x3";
    node(() => ({ result }));
    expect(await checkOnChainOrderCancelled("0x0dd", false)).toBe(true);
    const request = sent[0]!.params.request as { entry_point_selector: string };
    expect(sent[0]!.method).toBe("starknet_call");
    expect(BigInt(request.entry_point_selector)).toBe(BigInt(hash.getSelectorFromName("get_order_details")));
  });

  test("an order that cannot be read is not reported cancelled", async () => {
    node(() => ({ error: { code: 40, message: "Contract error" } }));
    expect(await checkOnChainOrderCancelled("0x0dd", false)).toBe(false);
  });

  test("the counter is read from get_counter", async () => {
    node(() => ({ result: ["0x5"] }));
    expect(await fetchCounter("0xa11ce")).toBe("5");
    const request = sent[0]!.params.request as { entry_point_selector: string };
    expect(BigInt(request.entry_point_selector)).toBe(BigInt(hash.getSelectorFromName("get_counter")));
  });

  test("a counter that cannot be read is an error", async () => {
    node(() => ({ error: { code: 40, message: "Contract error" } }));
    await expect(fetchCounter("0xa11ce")).rejects.toThrow();
  });

  test("the royalty bps is the royalty on a 10000-unit sale", async () => {
    node(() => ({ result: ["0xa11ce", "0x1f4"] }));
    expect(await fetchRoyaltyMaxBps("0xc0", "1")).toBe("500");
  });

  test("a collection without royalties reads as 0 bps", async () => {
    node(() => ({ error: { code: 40, message: "Contract error" } }));
    expect(await fetchRoyaltyMaxBps("0xc0", "1")).toBe("0");
  });
});
