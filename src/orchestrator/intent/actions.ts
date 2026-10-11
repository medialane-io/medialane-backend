import { cairo, Contract } from "starknet";
import {
  getTokenByAddress,
  STARKNET_COLLECTION_721_CONTRACT,
  STARKNET_GENESIS_MINT_CONTRACT,
  STARKNET_GENESIS_NFT_URI,
  STARKNET_NFTCOMMENTS_CONTRACT,
} from "@medialane/sdk";
import { encodeByteArray, IPCollectionABI } from "@medialane/sdk/starknet";
import { normalizeAddress, createProvider } from "../../utils/starknet.js";
import type { IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const u256 = (v: string | bigint): [string, string] => {
  const u = cairo.uint256(BigInt(v));
  return [String(u.low), String(u.high)];
};
const felts = (c: { calldata?: unknown }) => (Array.isArray(c.calldata) ? (c.calldata as unknown[]).map(String) : []);

export async function buildTransferTokenIntent(body: { owner: string; token: string; recipient: string; amount: string }) {
  const token = getTokenByAddress(addr(body.token));
  if (!token) throw new IntentRefusal("That token is not supported");
  const calls: IntentCall[] = [{ contractAddress: addr(token.address), entrypoint: "transfer", calldata: [addr(body.recipient), ...u256(body.amount)] }];
  return { calls };
}

export async function buildTransferNftIntent(body: {
  owner: string;
  contractAddress: string;
  tokenId: string;
  recipient: string;
  tokenStandard: "ERC721" | "ERC1155";
}) {
  const [low, high] = u256(body.tokenId);
  const from = addr(body.owner);
  const to = addr(body.recipient);
  const calls: IntentCall[] = body.tokenStandard === "ERC1155"
    ? [{ contractAddress: addr(body.contractAddress), entrypoint: "safe_transfer_from", calldata: [from, to, low, high, "1", "0", "0"] }]
    : [{ contractAddress: addr(body.contractAddress), entrypoint: "transfer_from", calldata: [from, to, low, high] }];
  return { calls };
}

export async function buildTransferCollectionOwnershipIntent(body: { owner: string; collectionId: string; newOwner: string }) {
  const contract = new Contract({ abi: IPCollectionABI as never, address: STARKNET_COLLECTION_721_CONTRACT, providerOrAccount: createProvider() as never });
  const call = contract.populate("transfer_collection_ownership", [cairo.uint256(BigInt(body.collectionId)), addr(body.newOwner)]);
  const calls: IntentCall[] = [{ contractAddress: STARKNET_COLLECTION_721_CONTRACT, entrypoint: "transfer_collection_ownership", calldata: felts(call) }];
  return { calls };
}

export async function buildCommentIntent(body: { author: string; nftContract: string; tokenId: string; text: string }) {
  const calls: IntentCall[] = [{
    contractAddress: STARKNET_NFTCOMMENTS_CONTRACT,
    entrypoint: "add_comment",
    calldata: [addr(body.nftContract), ...u256(body.tokenId), ...encodeByteArray(body.text.trim())],
  }];
  return { calls };
}

export async function buildGenesisMintIntent(body: { owner: string; recipient: string }) {
  const calls: IntentCall[] = [{
    contractAddress: STARKNET_GENESIS_MINT_CONTRACT,
    entrypoint: "mint_item",
    calldata: [addr(body.recipient), ...encodeByteArray(STARKNET_GENESIS_NFT_URI)],
  }];
  return { calls };
}
