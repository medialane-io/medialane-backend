import { test, expect, mock } from "bun:test";
import { num } from "starknet";
import { ORDER_CANCELLED_SELECTOR_HEX, ORDER_FULFILLED_SELECTOR_HEX } from "./_shared.js";
import { STARKNET_MARKETPLACE_721_CONTRACT } from "../../../config/constants.js";

const actualTxVerifier = await import("../../../utils/txVerifier.js");

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
    ...actualTxVerifier,
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
    ...actualTxVerifier,
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

const TX_HASH = `0x${"ab".repeat(32)}`;

function fulfilledEvent(fromAddress: string) {
  return {
    from_address: fromAddress,
    keys: [ORDER_FULFILLED_SELECTOR_HEX, ORDER_HASH, OFFERER, "0x2222"],
    data: [],
    block_number: 100,
    transaction_hash: TX_HASH,
    block_hash: "0xblock",
  };
}

async function hydrateFulfillmentWith(events: ReturnType<typeof fulfilledEvent>[]) {
  const handleOrderFulfilled = mock((..._args: unknown[]) => Promise.resolve({ isFinalFill: true }));
  mock.module("../../../mirror/handlers/orderFulfilled.js", () => ({
    handleOrderFulfilled,
    parseRawOrderFulfilled1155: mock(),
  }));
  mock.module("../../../mirror/handlers/transfer.js", () => ({ dispatchTransfer: mock() }));
  mock.module("../../../mirror/handlers/ownership.js", () => ({ writeOwnership: mock(() => Promise.resolve()) }));
  mock.module("../../../chainRead/ownership.js", () => ({
    ownershipKeys: () => [],
    readOwnership: mock(() => Promise.resolve([])),
  }));
  mock.module("../../../orchestrator/transferFollowup.js", () => ({
    runTransferFollowups: mock(() => Promise.resolve({})),
  }));
  mock.module("../../../db/client.js", () => ({
    default: { $transaction: mock((fn: (tx: unknown) => unknown) => fn({})) },
  }));
  mock.module("../../../utils/txVerifier.js", () => ({
    ...actualTxVerifier,
    fetchReceiptEvents: mock(() => Promise.resolve(events)),
  }));

  const { hydrateFulfillmentFromTx } = await import("./settle.js");
  await hydrateFulfillmentFromTx(TX_HASH);
  return handleOrderFulfilled;
}

test("hydrateFulfillmentFromTx ignores an OrderFulfilled event emitted by a contract that is not the marketplace", async () => {
  const handleOrderFulfilled = await hydrateFulfillmentWith([fulfilledEvent("0xdeadbeef")]);

  expect(handleOrderFulfilled).not.toHaveBeenCalled();
});

test("hydrateFulfillmentFromTx still applies an OrderFulfilled event emitted by the marketplace", async () => {
  const handleOrderFulfilled = await hydrateFulfillmentWith([fulfilledEvent(STARKNET_MARKETPLACE_721_CONTRACT)]);

  expect(handleOrderFulfilled).toHaveBeenCalledTimes(1);
});
