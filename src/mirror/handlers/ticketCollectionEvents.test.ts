import { describe, expect, test } from "bun:test";
import {
  decodeTicketCollectionCreatedEvent,
  decodeTicketMintedEvent,
  decodeTicketRedeemedEvent,
} from "./ticketCollectionEvents.js";

function event(keys: string[], data: string[] = []) {
  return {
    block_hash: "0x0",
    block_number: 1,
    transaction_hash: "0x1",
    from_address: "0xabc",
    keys,
    data,
  };
}

describe("decodeTicketCollectionCreatedEvent", () => {
  test("decodes collection_id (u256) and creator from keys", () => {
    const result = decodeTicketCollectionCreatedEvent(event(["0x0", "0x1", "0x0", "0xc01"]));
    expect(result?.collectionId).toBe("1");
    expect(result?.creator).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeTicketCollectionCreatedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeTicketMintedEvent", () => {
  test("decodes token_id, collection_id (both u256), and owner from keys", () => {
    const result = decodeTicketMintedEvent(event(["0x0", "0x5", "0x0", "0x1", "0x0", "0xd01"]));
    expect(result?.tokenId).toBe("5");
    expect(result?.collectionId).toBe("1");
    expect(result?.owner).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeTicketMintedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeTicketRedeemedEvent", () => {
  test("decodes token_id, collection_id (both u256), and owner from keys", () => {
    const result = decodeTicketRedeemedEvent(event(["0x0", "0x5", "0x0", "0x1", "0x0", "0xd01"]));
    expect(result?.tokenId).toBe("5");
    expect(result?.collectionId).toBe("1");
    expect(result?.owner).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeTicketRedeemedEvent(event(["0x0"]))).toBeNull();
  });
});
