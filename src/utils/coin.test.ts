import { describe, expect, test, mock } from "bun:test";
import { readTotalSupply } from "./coin.js";

describe("readTotalSupply", () => {
  test("reads total_supply and returns it as a decimal string", async () => {
    const callRpc = mock(async (fn: (provider: unknown) => Promise<string[]>) =>
      fn({ callContract: async () => ["0x3e8", "0x0"] } as any)
    );
    const result = await readTotalSupply("0xcoin", { callRpc: callRpc as any });
    expect(result).toBe("1000");
  });

  test("falls back to totalSupply (camelCase) if total_supply reverts", async () => {
    let calls = 0;
    const callRpc = mock(async (fn: (provider: unknown) => Promise<string[]>) => {
      calls++;
      return fn({
        callContract: async ({ entrypoint }: { entrypoint: string }) => {
          if (entrypoint === "total_supply") throw new Error("entrypoint not found");
          return ["0x64", "0x0"];
        },
      } as any);
    });
    const result = await readTotalSupply("0xcoin", { callRpc: callRpc as any });
    expect(result).toBe("100");
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
