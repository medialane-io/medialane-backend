import { describe, expect, test } from "bun:test";
import { CallData, byteArray, hash } from "starknet";
import { getTokenBySymbol, normalizeAddress } from "@medialane/sdk";
import { dropRow, parseDropCreated } from "./dropFactory.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const ORGANIZER = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";
const COLLECTION = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const USDC = normalizeAddress("STARKNET", getTokenBySymbol("USDC")!.address);
const encode = (s: string) => CallData.compile([byteArray.byteArrayFromString(s)]);

// keys: selector, drop_id (low, high), organizer
// data: collection, name, symbol, base_uri, max_supply (low, high),
//       terms (start, end, price low/high, token, max_per_wallet low/high), allowlist_root
const terms = ["0x0", "0x6b49d200", "0x4c4b40", "0x0", USDC, "0x5", "0x0"];
function event(data: string[] = [COLLECTION, ...encode("Neon Tides"), ...encode("NEON"), ...encode("ipfs://cid/"), "0x1f4", "0x0", ...terms, "0xabc"]): RawStarknetEvent {
  return { block_hash: "0xb", block_number: 16240900, transaction_hash: "0x1", from_address: "0xfac", keys: [hash.getSelectorFromName("DropCreated"), "0x7", "0x0", ORGANIZER], data };
}

describe("DropCreated", () => {
  test("decodes every creation-time fact", () => {
    expect(parseDropCreated(event())).toEqual({
      dropId: "7", organizer: ORGANIZER, collectionAddress: COLLECTION,
      name: "Neon Tides", symbol: "NEON", baseUri: "ipfs://cid/",
      maxSupply: "500", startTime: "0", endTime: "1800000000", price: "5000000", paymentToken: USDC, maxPerWallet: "5",
      allowlistRoot: "0xabc",
    });
  });

  test("keeps values beyond 64 bits exact", () => {
    const huge = [COLLECTION, ...encode("X"), ...encode("X"), ...encode("ipfs://x/"), "0xffffffffffffffffffffffffffffffff", "0x1",
      "0xffffffffffffffff", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0"];
    const d = parseDropCreated(event(huge))!;
    expect(d.maxSupply).toBe(((1n << 129n) - 1n).toString());
    expect(d.startTime).toBe("18446744073709551615");
    expect(d.allowlistRoot).toBe("0x0");
  });

  test("returns null for another event", () => {
    expect(parseDropCreated({ ...event(), keys: ["0x1", "0x7", "0x0", ORGANIZER] })).toBeNull();
  });

  test("the drop row records the creation block as the root's block", () => {
    const row = dropRow(parseDropCreated(event())!, 16240900n);
    expect(row).toMatchObject({ collectionAddress: COLLECTION, organizer: ORGANIZER, allowlistRoot: "0xabc", allowlistRootBlock: 16240900n, createdBlock: 16240900n, maxSupply: "500" });
  });
});
