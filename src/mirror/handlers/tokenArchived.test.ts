import { describe, expect, mock, test } from "bun:test";
import { num } from "starknet";
import { STARKNET_COLLECTION_721_CONTRACT, TOKEN_ARCHIVED_BATCH_SELECTOR, TOKEN_ARCHIVED_SELECTOR } from "../../config/constants.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const NFT = normalizeAddress("STARKNET", "0xc0de");

const findFirst = mock((..._args: unknown[]) => Promise.resolve<{ contractAddress: string } | null>({ contractAddress: NFT }));
const tokenUpdate = mock((args: unknown) => ({ kind: "token", args }));
const orderUpdate = mock((args: unknown) => ({ kind: "order", args }));
const transaction = mock((..._args: unknown[]) => Promise.resolve([]));
const readArchived = mock((..._args: unknown[]) => Promise.resolve(true));

mock.module("../../db/client.js", () => ({
  default: { collection: { findFirst }, token: { updateMany: tokenUpdate }, order: { updateMany: orderUpdate }, $transaction: transaction },
}));
mock.module("../../chainRead/archived.js", () => ({ readArchived }));

const event = (keys: string[], data: string[] = []): RawStarknetEvent =>
  ({ from_address: STARKNET_COLLECTION_721_CONTRACT, keys, data, block_number: 1, transaction_hash: "0x1" }) as unknown as RawStarknetEvent;

const single = event([num.toHex(TOKEN_ARCHIVED_SELECTOR), "0x7", "0x0", "0x2a", "0x0"], ["0xaa", "0x1"]);
const batch = event(
  [num.toHex(TOKEN_ARCHIVED_BATCH_SELECTOR)],
  ["0x2", "0x7", "0x0", "0x8", "0x0", "0x2", "0x2a", "0x0", "0x2b", "0x0", "0xaa", "0x1"],
);

async function run(events: RawStarknetEvent[]) {
  for (const m of [findFirst, tokenUpdate, orderUpdate, transaction, readArchived]) m.mockClear();
  const { applyTokensArchived } = await import("./tokenArchived.js");
  await applyTokensArchived(events);
}

describe("applyTokensArchived", () => {
  test("a single event marks its token archived and hidden, and closes its open orders in one write", async () => {
    await run([single]);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { collectionId: "7", service: "mip-erc721" } });
    expect(readArchived).toHaveBeenCalledWith({ contractAddress: NFT, tokenId: "42" });
    expect(tokenUpdate).toHaveBeenCalledWith({ where: { chain: "STARKNET", contractAddress: NFT, tokenId: "42" }, data: { isArchived: true, isHidden: true } });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { chain: "STARKNET", nftContract: NFT, nftTokenId: "42", status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test("a batch event handles every token in it", async () => {
    await run([batch]);
    expect(findFirst.mock.calls.map((c) => (c[0] as { where: { collectionId: string } }).where.collectionId)).toEqual(["7", "8"]);
    expect(tokenUpdate.mock.calls.map((c) => (c[0] as { where: { tokenId: string } }).where.tokenId)).toEqual(["42", "43"]);
  });

  test("a token the chain does not report as archived is left alone", async () => {
    readArchived.mockImplementationOnce(() => Promise.resolve(false));
    await run([single]);
    expect(transaction).not.toHaveBeenCalled();
  });

  test("an unknown collection changes nothing", async () => {
    findFirst.mockImplementationOnce(() => Promise.resolve(null));
    await run([single]);
    expect(readArchived).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
