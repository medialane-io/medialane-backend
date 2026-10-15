import { expect, test } from "bun:test";
import { nextSecretHashes } from "./appSecretStore.js";

test("adding keeps the newest previous hash, so at most two are valid", () => {
  expect(nextSecretHashes([], "n", false)).toEqual(["n"]);
  expect(nextSecretHashes(["a"], "n", false)).toEqual(["a", "n"]);
  expect(nextSecretHashes(["a", "b"], "n", false)).toEqual(["b", "n"]);
});

test("replace keeps only the new hash", () => {
  expect(nextSecretHashes(["a", "b"], "n", true)).toEqual(["n"]);
});
