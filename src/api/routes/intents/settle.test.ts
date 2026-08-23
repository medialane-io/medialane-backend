import { test, expect, mock } from "bun:test";
import { num } from "starknet";
import { ORDER_CANCELLED_SELECTOR_HEX } from "./_shared.js";

const ORDER_HASH = "0x1234";
const OTHER_ORDER_HASH = "0x5678";
const OFFERER = "0x1111";

function cancelledEvent(orderHash: string) {
  return {
    from_address: "0xmarketplace",
    keys: [ORDER_CANCELLED_SELECTOR_HEX, orderHash, OFFERER],
    data: [],
    block_number: 100,
    transaction_hash: "0xtx",
    block_hash: "0xblock",
  };
}

test("hydrateCancellationFromTx does not mark an order cancelled when the tx has no matching OrderCancelled event", async () => {
  const handleOrderCancelled = mock((_event: { orderHash: string }, ..._rest: unknown[]) => Promise.resolve());
  mock.module("../../../mirror/handlers/orderCancelled.js", () => ({ handleOrderCancelled }));
  mock.module("../../../db/client.js", () => ({
    default: { $transaction: mock((fn: (tx: unknown) => unknown) => fn({})) },
  }));
  mock.module("../../../utils/txVerifier.js", () => ({
    verifyMarketplaceTx: mock(),
    verifyTransactionSucceeded: mock(),
    checkOnChainOrderCancelled: mock(),
    fetchReceiptEvents: mock(),

    fetchMarketplaceReceiptEvents: mock(() => Promise.resolve([cancelledEvent(OTHER_ORDER_HASH)])),
  }));

  const { hydrateCancellationFromTx } = await import("./settle.js");
  const result = await hydrateCancellationFromTx("0xtx", ORDER_HASH);

  expect(result).toBe(false);
  expect(handleOrderCancelled).not.toHaveBeenCalled();
});

test("hydrateCancellationFromTx marks the order cancelled only for a matching OrderCancelled event", async () => {
  const handleOrderCancelled = mock((_event: { orderHash: string }, ..._rest: unknown[]) => Promise.resolve());
  mock.module("../../../mirror/handlers/orderCancelled.js", () => ({ handleOrderCancelled }));
  mock.module("../../../db/client.js", () => ({
    default: { $transaction: mock((fn: (tx: unknown) => unknown) => fn({})) },
  }));
  mock.module("../../../utils/txVerifier.js", () => ({
    verifyMarketplaceTx: mock(),
    verifyTransactionSucceeded: mock(),
    checkOnChainOrderCancelled: mock(),
    fetchReceiptEvents: mock(),
    fetchMarketplaceReceiptEvents: mock(() =>
      Promise.resolve([cancelledEvent(OTHER_ORDER_HASH), cancelledEvent(ORDER_HASH)])
    ),
  }));

  const { hydrateCancellationFromTx } = await import("./settle.js");
  const result = await hydrateCancellationFromTx("0xtx", ORDER_HASH);

  expect(result).toBe(true);
  expect(handleOrderCancelled).toHaveBeenCalledTimes(1);
  const [event] = handleOrderCancelled.mock.calls[0]!;
  expect(num.toHex(event.orderHash)).toBe(num.toHex(ORDER_HASH));
});
