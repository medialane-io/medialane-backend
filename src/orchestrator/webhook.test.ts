import { describe, expect, test } from "bun:test";
import { drainPendingDeliveries } from "./webhook.js";

describe("draining pending webhook deliveries", () => {
  test("one failing delivery does not stop the ones after it", async () => {
    const processed: string[] = [];
    await drainPendingDeliveries({
      findPending: async () => [{ id: "bad" }, { id: "ok1" }, { id: "ok2" }],
      process: async (id) => {
        processed.push(id);
        if (id === "bad") throw new Error("Endpoint returned 500");
      },
    });
    expect(processed).toEqual(["bad", "ok1", "ok2"]);
  });

  test("a lookup failure still surfaces to the loop", async () => {
    await expect(
      drainPendingDeliveries({
        findPending: async () => {
          throw new Error("db down");
        },
        process: async () => {},
      }),
    ).rejects.toThrow("db down");
  });
});
