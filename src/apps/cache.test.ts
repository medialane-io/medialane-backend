import { describe, expect, mock, test } from "bun:test";
import { cachedAppNameForClient } from "./cache.js";

describe("cachedAppNameForClient", () => {
  test("looks a client up once within the time to live, including a null answer", async () => {
    let now = 1_000;
    const lookup = mock(async (id: string) => (id === "c1" ? "MEDIALANE_IO" : null));
    const get = cachedAppNameForClient(lookup, { ttlMs: 60_000, now: () => now });
    expect(await get("c1")).toBe("MEDIALANE_IO");
    expect(await get("c1")).toBe("MEDIALANE_IO");
    expect(await get("unbound-client")).toBeNull();
    expect(await get("unbound-client")).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    now += 60_001;
    await get("c1");
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
