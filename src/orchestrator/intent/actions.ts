import { cairo } from "starknet";
import { getTokenByAddress, STARKNET_NFTCOMMENTS_CONTRACT } from "@medialane/sdk";
import {
  buildIntent,
  encodeByteArray,
  type GenesisMintIntentParams,
  type TransferCollectionOwnershipIntentParams,
  type TransferNftIntentParams,
  type TransferTokenIntentParams,
} from "@medialane/sdk/starknet";
import { sdkConfig } from "./sdkConfig.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const u256 = (v: string | bigint): [string, string] => {
  const u = cairo.uint256(BigInt(v));
  return [String(u.low), String(u.high)];
};

export async function buildTransferTokenIntent(body: TransferTokenIntentParams) {
  if (!getTokenByAddress(addr(body.token))) throw new IntentRefusal("That token is not supported");
  return buildIntent("transfer-token", body, {}, sdkConfig);
}

export async function buildTransferNftIntent(body: TransferNftIntentParams) {
  return buildIntent("transfer-nft", body, {}, sdkConfig);
}

export async function buildTransferCollectionOwnershipIntent(body: TransferCollectionOwnershipIntentParams) {
  return buildIntent("transfer-collection-ownership", body, {}, sdkConfig);
}

export async function buildCommentIntent(body: { author: string; nftContract: string; tokenId: string; text: string }) {
  const calls: IntentCall[] = [{
    contractAddress: STARKNET_NFTCOMMENTS_CONTRACT,
    entrypoint: "add_comment",
    calldata: [addr(body.nftContract), ...u256(body.tokenId), ...encodeByteArray(body.text.trim())],
  }];
  return { calls };
}

export async function buildGenesisMintIntent(body: GenesisMintIntentParams) {
  return buildIntent("genesis-mint", body, {}, sdkConfig);
}
