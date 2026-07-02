import { describe, expect, test } from "bun:test";
import { decodeNewClubCreatedEvent } from "./ipClub.js";

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

describe("decodeNewClubCreatedEvent", () => {
  test("decodes club_id (u256) and creator from keys, club_nft from data[0]", () => {
    const result = decodeNewClubCreatedEvent(
      event(
        [
          "0x0", // selector
          "0x1", // club_id.low
          "0x0", // club_id.high
          "0xabc", // creator
        ],
        ["0xdef"], // club_nft
      ),
    );
    expect(result?.clubId).toBe("1");
    expect(result?.clubAddress).toBeDefined();
    expect(result?.creator).toBeDefined();
  });

  test("returns null when keys/data are too short", () => {
    expect(decodeNewClubCreatedEvent(event(["0x0"]))).toBeNull();
  });
});
