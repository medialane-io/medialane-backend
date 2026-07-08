import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { decodeSolanaLogs } from "./decode.js";

function u64le(v: bigint): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...b];
}
function str(s: string): number[] {
  const b = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, true);
  return [...len, ...b];
}
function programData(event: string, payload: number[]): string {
  const d = sha256(new TextEncoder().encode(`event:${event}`)).slice(0, 8);
  return "Program data: " + Buffer.from([...d, ...payload]).toString("base64");
}

const KEY = new Uint8Array(32).fill(7);
const KEY58 = base58.encode(KEY);

describe("decodeSolanaLogs", () => {
  test("decodes OrderCreated + skips noise", () => {
    const line = programData("OrderCreated", [...KEY, ...KEY]);
    const events = decodeSolanaLogs(["Program log: hello", line, "Program data: !!!bad"]);
    expect(events).toEqual([{ kind: "OrderCreated", order: KEY58, offerer: KEY58 }]);
  });
  test("decodes CollectionCreated with strings", () => {
    const line = programData("CollectionCreated", [...u64le(3n), ...KEY, ...KEY, ...str("My IP"), ...str("ipfs://c")]);
    expect(decodeSolanaLogs([line])).toEqual([
      { kind: "CollectionCreated", collectionId: 3n, coreCollection: KEY58, creator: KEY58, name: "My IP", uri: "ipfs://c" },
    ]);
  });
  test("decodes OrderFulfilled amounts", () => {
    const line = programData("OrderFulfilled", [...KEY, ...KEY, ...KEY, ...u64le(10n ** 9n), ...KEY, ...u64le(5n)]);
    const [e] = decodeSolanaLogs([line]);
    expect(e).toMatchObject({ kind: "OrderFulfilled", saleAmount: 10n ** 9n, royaltyAmount: 5n });
  });
});
