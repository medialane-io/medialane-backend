import { describe, expect, test } from "bun:test";
import { buildCreateCollectionIntent } from "./collection.js";

const OWNER = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";

describe("a pop-protocol collection", () => {
  test("is encoded for the factory's create_collection with its event type", async () => {
    const { calls } = await buildCreateCollectionIntent({
      owner: OWNER,
      name: "Pilot",
      symbol: "PLT",
      baseUri: "ipfs://bafytest",
      service: "pop-protocol",
      claimEndTimestamp: 0,
      eventType: "Course",
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("create_collection");
    expect(calls[0]!.calldata?.length).toBeGreaterThan(0);
  });

  test("a different event type changes the encoded variant", async () => {
    const encode = async (eventType: string) =>
      (await buildCreateCollectionIntent({
        owner: OWNER, name: "Pilot", symbol: "PLT", baseUri: "ipfs://bafytest",
        service: "pop-protocol", claimEndTimestamp: 0, eventType,
      } as never)).calls[0]!.calldata;
    expect(await encode("Course")).not.toEqual(await encode("Workshop"));
  });
});
