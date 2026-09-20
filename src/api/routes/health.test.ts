import { describe, expect, test } from "bun:test";
import { indexerState, INDEXER_STALL_MS } from "./health.js";

const NOW = new Date("2026-09-20T20:00:00Z").getTime();

describe("what health says about the indexer", () => {
  test("a cursor that moved moments ago is ok", () => {
    expect(indexerState(new Date(NOW - 30_000), NOW)).toMatchObject({ indexer: "ok" });
  });

  test("a cursor that stopped moving is stalled, not ok", () => {
    expect(indexerState(new Date(NOW - INDEXER_STALL_MS - 1), NOW)).toMatchObject({ indexer: "stalled" });
  });

  test("the 39 hour outage would have read as stalled", () => {
    const state = indexerState(new Date(NOW - 39 * 60 * 60 * 1000), NOW);
    expect(state.indexer).toBe("stalled");
    expect(state.staleForMs).toBe(39 * 60 * 60 * 1000);
  });

  test("no cursor at all is reported rather than assumed healthy", () => {
    expect(indexerState(null, NOW)).toEqual({ indexer: "missing" });
  });
});
