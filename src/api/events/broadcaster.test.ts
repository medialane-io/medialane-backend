import { describe, expect, test } from "bun:test";
import { EventsBroadcaster, type SseEvent, type FetchNewEvents } from "./broadcaster.js";

function evt(chain: string, id: string): SseEvent {
  return { id, event: "transfer", data: "{}", chain: chain as SseEvent["chain"] };
}

function fetcherOf(batches: SseEvent[][]): FetchNewEvents {
  let call = 0;
  return async () => ({ events: batches[Math.min(call++, batches.length - 1)] ?? [], next: new Date() });
}

test("fans one fetch out to all subscribers, filtered by chain", async () => {
  const b = new EventsBroadcaster(fetcherOf([[evt("STARKNET", "1"), evt("ETHEREUM", "2")]]), 60_000);
  const starknetSeen: string[] = [];
  const allSeen: string[] = [];
  const un1 = b.subscribe({ chain: "STARKNET", push: (e) => starknetSeen.push(e.id) });
  const un2 = b.subscribe({ chain: "all", push: (e) => allSeen.push(e.id) });

  await b.tick();
  expect(starknetSeen).toEqual(["1"]);
  expect(allSeen).toEqual(["1", "2"]);
  un1();
  un2();
});

test("loop stops when the last subscriber leaves", async () => {
  const b = new EventsBroadcaster(fetcherOf([[]]), 60_000);
  const unsub = b.subscribe({ chain: "all", push: () => {} });
  expect(b.subscriberCount).toBe(1);
  unsub();
  expect(b.subscriberCount).toBe(0);
});

test("a fetch error does not kill the loop", async () => {
  let calls = 0;
  const failingOnce: FetchNewEvents = async () => {
    calls++;
    if (calls === 1) throw new Error("db down");
    return { events: [evt("STARKNET", "after")], next: new Date() };
  };
  const b = new EventsBroadcaster(failingOnce, 60_000);
  const seen: string[] = [];
  const unsub = b.subscribe({ chain: "all", push: (e) => seen.push(e.id) });
  await b.tick(); // error swallowed
  await b.tick();
  expect(seen).toEqual(["after"]);
  unsub();
});
