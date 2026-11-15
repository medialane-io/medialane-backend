import { describe, expect, mock, test } from "bun:test";
import { num } from "starknet";
import { COLLECTION_OWNERSHIP_TRANSFERRED_SELECTOR, OWNERSHIP_TRANSFERRED_SELECTOR, STARKNET_COLLECTION_721_CONTRACT } from "../../config/constants.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const CONTRACT = normalizeAddress("STARKNET", "0xc0de");
const NEW_OWNER = normalizeAddress("STARKNET", "0xb0b");

const findFirst = mock((..._args: unknown[]) => Promise.resolve<{ contractAddress: string } | null>({ contractAddress: CONTRACT }));
const updateMany = mock((..._args: unknown[]) => Promise.resolve({ count: 1 }));
const currentCollectionOwner = mock((..._args: unknown[]) => Promise.resolve(NEW_OWNER));

mock.module("../../db/client.js", () => ({ default: { collection: { findFirst, updateMany } } }));
mock.module("../../utils/collectionOwner.js", () => ({ currentCollectionOwner }));

const event = (from: string, keys: string[]): RawStarknetEvent =>
  ({ from_address: from, keys, data: [], block_number: 1, transaction_hash: "0x1" }) as unknown as RawStarknetEvent;

const registryEvent = event(STARKNET_COLLECTION_721_CONTRACT, [num.toHex(COLLECTION_OWNERSHIP_TRANSFERRED_SELECTOR), "0x7", "0x0"]);
const ownableEvent = event(CONTRACT, [num.toHex(OWNERSHIP_TRANSFERRED_SELECTOR), "0x1", "0x2"]);

async function run(events: RawStarknetEvent[]) {
  findFirst.mockClear();
  updateMany.mockClear();
  currentCollectionOwner.mockClear();
  const { applyOwnershipChanges } = await import("./collectionOwner.js");
  await applyOwnershipChanges(events);
}

describe("applyOwnershipChanges", () => {
  test("a registry event finds its collection by id and stores the owner the chain reports", async () => {
    await run([registryEvent]);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { collectionId: "7", service: "mip-erc721" } });
    expect(updateMany).toHaveBeenCalledWith({ where: { chain: "STARKNET", contractAddress: CONTRACT }, data: { owner: NEW_OWNER } });
  });

  test("an ownership event from a collection contract refreshes that contract", async () => {
    await run([ownableEvent]);
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({ where: { chain: "STARKNET", contractAddress: CONTRACT }, data: { owner: NEW_OWNER } });
  });

  test("several events for one collection read the chain once", async () => {
    await run([ownableEvent, ownableEvent]);
    expect(currentCollectionOwner).toHaveBeenCalledTimes(1);
  });

  test("other events and unknown registry collections change nothing", async () => {
    findFirst.mockImplementationOnce(() => Promise.resolve(null));
    await run([registryEvent, event(CONTRACT, [num.toHex("0x1234")])]);
    expect(currentCollectionOwner).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
