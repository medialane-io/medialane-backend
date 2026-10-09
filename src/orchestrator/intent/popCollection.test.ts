import { describe, expect, test } from "bun:test";
import { buildCreateCollectionIntent } from "./collection.js";

const OWNER = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";

describe("a pop-protocol collection", () => {
  test("is created with name, symbol, base URI and deadline", async () => {
    const { calls } = await buildCreateCollectionIntent({
      owner: OWNER, name: "Pilot", symbol: "PLT", baseUri: "ipfs://bafytest",
      service: "pop-protocol", claimEndTimestamp: 1700000000,
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("create_collection");
    expect((calls[0]!.calldata as string[]).at(-1)).toBe("1700000000");
  });

  test("defaults the deadline to none", async () => {
    const { calls } = await buildCreateCollectionIntent({
      owner: OWNER, name: "Pilot", symbol: "PLT", baseUri: "ipfs://bafytest", service: "pop-protocol",
    } as never);
    expect((calls[0]!.calldata as string[]).at(-1)).toBe("0");
  });
});
