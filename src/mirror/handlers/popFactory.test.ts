import { describe, expect, test } from "bun:test";
import { CallData, byteArray, hash } from "starknet";
import { parsePopCollectionCreated } from "./popFactory.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const ORGANIZER = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";
const COLLECTION = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const encode = (s: string) => CallData.compile([byteArray.byteArrayFromString(s)]);

// keys: selector, collection_id (u256 low, high), organizer
// data: collection_address, name, symbol, base_uri (ByteArrays), claim_end_time
function event(overrides: Partial<RawStarknetEvent> = {}): RawStarknetEvent {
  return {
    block_hash: "0xb",
    block_number: 42,
    transaction_hash: "0x1",
    from_address: "0xfac",
    keys: [hash.getSelectorFromName("CollectionCreated"), "0x7", "0x0", ORGANIZER],
    data: [COLLECTION, ...encode("Pilot"), ...encode("PLT"), ...encode("ipfs://e.json"), "0x4d2"],
    ...overrides,
  };
}

describe("POP CollectionCreated", () => {
  test("decodes the collection, its organizer and its metadata", () => {
    expect(parsePopCollectionCreated(event())).toEqual({
      collectionId: "7",
      organizer: ORGANIZER,
      collectionAddress: COLLECTION,
      name: "Pilot",
      symbol: "PLT",
      baseUri: "ipfs://e.json",
      claimEndTime: 1234n,
    });
  });

  test("decodes a long base URI that spans several felts", () => {
    const uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json";
    const parsed = parsePopCollectionCreated(
      event({ data: [COLLECTION, ...encode("Pilot"), ...encode("PLT"), ...encode(uri), "0x0"] }),
    );
    expect(parsed!.baseUri).toBe(uri);
  });

  test("returns null for an event that isn't a POP CollectionCreated", () => {
    expect(parsePopCollectionCreated(event({ keys: ["0x1", "0x7", "0x0", ORGANIZER] }))).toBeNull();
  });
});
