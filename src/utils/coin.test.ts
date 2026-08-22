import { describe, expect, test, mock } from "bun:test";
import { readTotalSupply, upsertCoin, probeUnruggableInterface } from "./coin.js";

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

describe("upsertCoin", () => {
  function fakeDb() {
    const calls: any[] = [];
    return { calls, db: { coin: { upsert: async (args: any) => { calls.push(args); } } } as any };
  }

  test("accepts external-erc20, the service claimed memecoins use", async () => {
    const { calls, db } = fakeDb();
    await upsertCoin(db, {
      chain: "STARKNET",
      contractAddress: "0xcoin",
      service: "external-erc20",
      name: "StarkPepe",
      symbol: "SPEPE",
      decimals: 18,
      totalSupply: "42000000000000000000000000000",
      startBlock: 0n,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].create.service).toBe("external-erc20");
    expect(calls[0].create.standard).toBe("ERC20");
    expect(calls[0].create.totalSupply).toBe("42000000000000000000000000000");
  });

  test("accepts creator-coin", async () => {
    const { calls, db } = fakeDb();
    await upsertCoin(db, {
      chain: "STARKNET",
      contractAddress: "0xcoin",
      service: "creator-coin",
      startBlock: 0n,
    });
    expect(calls[0].create.service).toBe("creator-coin");
  });

  test("rejects a service that is not a coin service", async () => {
    const { db } = fakeDb();
    await expect(
      upsertCoin(db, {
        chain: "STARKNET",
        contractAddress: "0xcoin",
        service: "external-erc721",
        startBlock: 0n,
      }),
    ).rejects.toThrow(/Unknown coin service/);
  });
});

describe("probeUnruggableInterface", () => {
  function provider(available: Set<string>) {
    return mock(async (fn: (p: unknown) => Promise<string[]>) =>
      fn({
        callContract: async ({ entrypoint }: { entrypoint: string }) => {
          if (!available.has(entrypoint)) throw new Error("entrypoint not found");
          return ["0x1", "0x0"];
        },
      } as any)
    );
  }

  test("true when both is_launched and get_team_allocation answer", async () => {
    const callRpc = provider(new Set(["is_launched", "get_team_allocation"]));
    expect((await probeUnruggableInterface("0xc", { callRpc: callRpc as any })).exposesInterface).toBe(true);
  });

  test("false for a plain ERC-20 exposing neither", async () => {
    const callRpc = provider(new Set(["name", "symbol", "total_supply"]));
    const r = await probeUnruggableInterface("0xc", { callRpc: callRpc as any });
    expect(r.exposesInterface).toBe(false);
    expect(r.isLaunched).toBeNull();
  });

  test("false when only one half of the interface answers", async () => {
    const callRpc = provider(new Set(["is_launched"]));
    expect((await probeUnruggableInterface("0xc", { callRpc: callRpc as any })).exposesInterface).toBe(false);
  });

  test("reports the launch state it already read", async () => {
    const callRpc = provider(new Set(["is_launched", "get_team_allocation"]));
    expect((await probeUnruggableInterface("0xc", { callRpc: callRpc as any })).isLaunched).toBe(true);
  });
});

describe("upsertCoin unruggable service", () => {
  test("accepts unruggable-erc20", async () => {
    const calls: any[] = [];
    const db = { coin: { upsert: async (a: any) => { calls.push(a); } } } as any;
    await upsertCoin(db, {
      chain: "STARKNET",
      contractAddress: "0xcoin",
      service: "unruggable-erc20",
      startBlock: 0n,
    });
    expect(calls[0].create.service).toBe("unruggable-erc20");
  });
});
