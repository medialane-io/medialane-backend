import { describe, expect, test } from "bun:test";
import { decodeNewClubCreatedEvent, decodeClubStatusUpdatedEvent, decodeNewMemberEvent, decodeMemberLeftEvent } from "./ipClub.js";

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

describe("decodeClubStatusUpdatedEvent", () => {
  test("decodes club_id (u256) and open from keys/data", () => {
    const result = decodeClubStatusUpdatedEvent(event(["0x0", "0x1", "0x0"], ["0x1", "0x64"]));
    expect(result?.clubId).toBe("1");
    expect(result?.open).toBe(true);
  });

  test("returns null when data is missing", () => {
    expect(decodeClubStatusUpdatedEvent(event(["0x0", "0x1", "0x0"], []))).toBeNull();
  });
});

describe("decodeNewMemberEvent / decodeMemberLeftEvent", () => {
  test("decodes club_id (u256) and member from keys", () => {
    const result = decodeNewMemberEvent(event(["0x0", "0x1", "0x0", "0xabc"]));
    expect(result?.clubId).toBe("1");
    expect(result?.member).toBeDefined();
    expect(decodeMemberLeftEvent(event(["0x0", "0x1", "0x0", "0xabc"]))?.clubId).toBe("1");
  });

  test("returns null when keys are too short", () => {
    expect(decodeNewMemberEvent(event(["0x0"]))).toBeNull();
  });
});
