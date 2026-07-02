import { describe, expect, test } from "bun:test";
import { decodeCollectionDeployedEvent } from "./ticketCollectionFactory.js";

function event(keys: string[], data: string[] = []) {
  return {
    block_hash: "0x0",
    block_number: 100,
    transaction_hash: "0x1",
    from_address: "0x0",
    keys,
    data,
  };
}

describe("decodeCollectionDeployedEvent", () => {
  test("decodes collection_address and owner from keys", () => {
    const result = decodeCollectionDeployedEvent(
      event([
        "0x0", // selector — not read by the decoder
        "0xabc", // collection_address
        "0xdef", // owner
      ]),
    );
    expect(result?.collectionAddress).toBeDefined();
    expect(result?.owner).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeCollectionDeployedEvent(event(["0x0"]))).toBeNull();
  });
});
