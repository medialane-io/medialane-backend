import { describe, expect, test } from "bun:test";
import orders from "./orders.js";

describe("GET / order list price filters", () => {
  test("a non-numeric minPrice or maxPrice is a 400, not a database error", async () => {
    for (const q of ["minPrice=abc", "maxPrice=1.5", "minPrice=-1"]) {
      expect((await orders.request(`/?${q}`)).status).toBe(400);
    }
  });
});
