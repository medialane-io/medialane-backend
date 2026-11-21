import { describe, expect, test, mock } from "bun:test";

const ACCOUNT = "0x0000000000000000000000000000000000000000000000000000000000000abc";

describe("starknet get_escape_and_status readyAt", () => {
  test("returns null when there is no active escape (readyAt is 0)", async () => {
    const fakeProvider = { callContract: mock(async () => ["0x0", "0x0", "0x0", "0x0", "0x0", "0x0"]) };
    const { __unstable_starknetGetEscapeReadyAtWithProvider } = await import("./index.js");
    const result = await __unstable_starknetGetEscapeReadyAtWithProvider(fakeProvider as any, ACCOUNT);
    expect(result).toBeNull();
  });

  test("returns the ready time as a Date when an escape is pending", async () => {
    const readyAtSeconds = 1_800_000_000;
    const fakeProvider = {
      callContract: mock(async () => [
        `0x${readyAtSeconds.toString(16)}`,
        "0x2",
        "0x1",
        "0x2",
      ]),
    };
    const { __unstable_starknetGetEscapeReadyAtWithProvider } = await import("./index.js");
    const result = await __unstable_starknetGetEscapeReadyAtWithProvider(fakeProvider as any, ACCOUNT);
    expect(result).toEqual(new Date(readyAtSeconds * 1000));
  });
});
