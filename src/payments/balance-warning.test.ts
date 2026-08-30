import { test, expect } from "bun:test";
import { thresholdCrossed, severityFor, BALANCE_THRESHOLDS } from "./balance-warning.js";

test("crossing a threshold is reported once, on the transition", () => {
  expect(thresholdCrossed(50_001, 49_999)).toBe(50_000);
});

test("sitting below a threshold is not reported again", () => {
  expect(thresholdCrossed(49_999, 49_998)).toBeNull();
  expect(thresholdCrossed(900, 899)).toBeNull();
});

test("landing exactly on a threshold counts as crossing it", () => {
  expect(thresholdCrossed(50_001, 50_000)).toBe(50_000);
});

test("a balance well above every threshold is silent", () => {
  expect(thresholdCrossed(900_000, 899_985)).toBeNull();
});

test("a large single spend reports the lowest threshold it passed, not the first", () => {
  expect(thresholdCrossed(60_000, 500)).toBe(1_000);
});

test("reaching zero is reported", () => {
  expect(thresholdCrossed(10, 0)).toBe(0);
});

test("a refund cannot raise a warning", () => {
  expect(thresholdCrossed(400, 10_000)).toBeNull();
  expect(thresholdCrossed(500, 500)).toBeNull();
});

test("running out is an error, approaching is a warning", () => {
  expect(severityFor(50_000)).toBe("warn");
  expect(severityFor(10_000)).toBe("warn");
  expect(severityFor(1_000)).toBe("error");
  expect(severityFor(0)).toBe("error");
});

test("thresholds descend, so the crossing search returns the most severe", () => {
  const sorted = [...BALANCE_THRESHOLDS].sort((a, b) => b - a);
  expect([...BALANCE_THRESHOLDS]).toEqual(sorted);
});
