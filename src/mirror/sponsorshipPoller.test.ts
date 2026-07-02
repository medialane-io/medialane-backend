import { describe, expect, test } from "bun:test";
import {
  decodeOfferCreatedEvent,
  decodeOfferStatusUpdatedEvent,
  decodeBidPlacedEvent,
  decodeBidRetractedEvent,
  decodeSponsorshipAcceptedEvent,
  decodeLicenseTransferredEvent,
} from "./sponsorshipPoller.js";

function event(keys: string[], data: string[] = []) {
  return {
    block_hash: "0x0",
    block_number: 1,
    transaction_hash: "0x1",
    from_address: "0x0",
    keys,
    data,
  };
}

describe("decodeOfferCreatedEvent", () => {
  test("decodes offer_id (u256), author, nft_contract from keys", () => {
    const result = decodeOfferCreatedEvent(
      event(["0x0", "0x1", "0x0", "0xa01", "0xa02"]),
    );
    expect(result?.offerId).toBe("1");
    expect(result?.author).toBeDefined();
    expect(result?.nftContract).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeOfferCreatedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeOfferStatusUpdatedEvent", () => {
  test("decodes offer_id (u256) and open from keys/data", () => {
    const result = decodeOfferStatusUpdatedEvent(event(["0x0", "0x1", "0x0"], ["0x1", "0x64"]));
    expect(result?.offerId).toBe("1");
    expect(result?.open).toBe(true);
  });

  test("returns null when data is missing", () => {
    expect(decodeOfferStatusUpdatedEvent(event(["0x0", "0x1", "0x0"], []))).toBeNull();
  });
});

describe("decodeBidPlacedEvent", () => {
  test("decodes offer_id (u256) and sponsor from keys", () => {
    const result = decodeBidPlacedEvent(event(["0x0", "0x1", "0x0", "0xb01"]));
    expect(result?.offerId).toBe("1");
    expect(result?.sponsor).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeBidPlacedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeBidRetractedEvent", () => {
  test("decodes offer_id (u256) and sponsor from keys", () => {
    const result = decodeBidRetractedEvent(event(["0x0", "0x1", "0x0", "0xb02"]));
    expect(result?.offerId).toBe("1");
    expect(result?.sponsor).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeBidRetractedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeSponsorshipAcceptedEvent", () => {
  test("decodes offer_id, license_id (both u256), sponsor from keys", () => {
    const result = decodeSponsorshipAcceptedEvent(
      event(["0x0", "0x1", "0x0", "0x1", "0x0", "0xc01"]),
    );
    expect(result?.offerId).toBe("1");
    expect(result?.licenseId).toBe("1");
    expect(result?.sponsor).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeSponsorshipAcceptedEvent(event(["0x0"]))).toBeNull();
  });
});

describe("decodeLicenseTransferredEvent", () => {
  test("decodes license_id (u256) and to from keys", () => {
    const result = decodeLicenseTransferredEvent(event(["0x0", "0x1", "0x0", "0xd01", "0xd02"]));
    expect(result?.licenseId).toBe("1");
    expect(result?.to).toBeDefined();
  });

  test("returns null when keys are too short", () => {
    expect(decodeLicenseTransferredEvent(event(["0x0"]))).toBeNull();
  });
});
