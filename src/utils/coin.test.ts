import { describe, expect, test, mock } from "bun:test";
import { readTotalSupply, upsertCoin, probeUnruggableInterface, resolveCoin } from "./coin.js";

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

describe("resolveCoin", () => {
  function provider(available: Record<string, string[]>) {
    return mock(async (fn: (p: unknown) => Promise<string[]>) =>
      fn({
        callContract: async ({ entrypoint }: { entrypoint: string }) => {
          const r = available[entrypoint];
          if (!r) throw new Error("entrypoint not found");
          return r;
        },
      } as any)
    );
  }

  const erc20 = {
    name: ["0x537461726b50657065"],
    symbol: ["0x5350455045"],
    decimals: ["0x12"],
    total_supply: ["0x3e8", "0x0"],
  };

  test("classifies a plain ERC-20 as external-erc20", async () => {
    const callRpc = provider(erc20);
    const r = await resolveCoin("0xc", false, { callRpc: callRpc as any });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coin.service).toBe("external-erc20");
      expect(r.coin.symbol).toBe("SPEPE");
      expect(r.coin.totalSupply).toBe("1000");
      expect(r.coin.isLaunched).toBeNull();
    }
  });

  test("classifies an unruggable contract and carries its launch state", async () => {
    const callRpc = provider({ ...erc20, is_launched: ["0x1"], get_team_allocation: ["0x0", "0x0"] });
    const r = await resolveCoin("0xc", false, { callRpc: callRpc as any });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coin.service).toBe("unruggable-erc20");
      expect(r.coin.isLaunched).toBe(true);
    }
  });

  test("a factory-recognised coin is a creator-coin regardless of interface", async () => {
    const callRpc = provider(erc20);
    const r = await resolveCoin("0xc", true, { callRpc: callRpc as any });
    if (r.ok) expect(r.coin.service).toBe("creator-coin");
  });

  test("rejects an address exposing neither name nor symbol", async () => {
    const callRpc = provider({ total_supply: ["0x1", "0x0"] });
    const r = await resolveCoin("0xc", false, { callRpc: callRpc as any });
    expect(r).toEqual({ ok: false, reason: "not_erc20" });
  });

  test("rejects an address with no readable total supply", async () => {
    const callRpc = provider({ name: erc20.name, symbol: erc20.symbol, decimals: erc20.decimals });
    const r = await resolveCoin("0xc", false, { callRpc: callRpc as any });
    expect(r).toEqual({ ok: false, reason: "no_total_supply" });
  });
});
