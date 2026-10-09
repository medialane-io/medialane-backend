import { test, expect } from "bun:test";
import { popCollectionFilter } from "./compute.js";

test("pop collections are found by their service, not by allowlist rows", () => {
  expect(popCollectionFilter()).toEqual({ service: "pop-protocol", deletedAt: null });
});
