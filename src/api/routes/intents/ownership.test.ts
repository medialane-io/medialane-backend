import { describe, expect, test } from "bun:test";
import { belongsToCaller } from "./lifecycle.js";

describe("which intents a caller may act on", () => {
  test("its own", () => {
    expect(belongsToCaller("acc_1", "acc_1")).toBe(true);
  });

  test("not another caller's", () => {
    expect(belongsToCaller("acc_1", "acc_2")).toBe(false);
  });

  test("an intent belonging to nobody belongs to nobody", () => {
    expect(belongsToCaller(null, "acc_1")).toBe(false);
  });
});
