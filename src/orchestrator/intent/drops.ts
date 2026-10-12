import { cairo } from "starknet";
import type { ResolvedFeeConfig } from "@medialane/sdk";
import { DROP_MAX_CLAIM_QUANTITY, dropCalls, encodeByteArray, readDrop, type DropOnchain } from "@medialane/sdk/starknet";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { isListableToken, toIntentCall } from "./calls.js";
import { platformFeeCalls, platformFeeConfig, type IntentBuildContext, type IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const u256 = (v: string | bigint): [string, string] => {
  const u = cairo.uint256(BigInt(v));
  return [String(u.low), String(u.high)];
};

export type DropReader = (collection: string) => Promise<DropOnchain>;

export const chainDrop: DropReader = (collection) => callRpc((provider) => readDrop(provider, collection));

/** Tokens minted in one transaction: 1 to DROP_MAX_CLAIM_QUANTITY. */
function batchQuantity(raw: string | undefined): bigint {
  const q = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  if (q < 1n || q > DROP_MAX_CLAIM_QUANTITY) throw new IntentRefusal(`quantity must be between 1 and ${DROP_MAX_CLAIM_QUANTITY}`);
  return q;
}

export async function buildPopClaimIntent(body: { claimer: string; collection: string; proof: string[] }) {
  const calls: IntentCall[] = [{ contractAddress: addr(body.collection), entrypoint: "claim", calldata: [String(body.proof.length), ...body.proof] }];
  return { calls };
}

export async function buildPopBurnIntent(body: { owner: string; collection: string; tokenId: string }) {
  const calls: IntentCall[] = [{ contractAddress: addr(body.collection), entrypoint: "burn", calldata: u256(body.tokenId) }];
  return { calls };
}

export async function buildDropClaimIntent(
  body: { claimer: string; collection: string; quantity: string; proof?: string[] },
  ctx: IntentBuildContext = { appId: "" },
  read: DropReader = chainDrop,
  cfg: ResolvedFeeConfig = platformFeeConfig,
) {
  const quantity = batchQuantity(body.quantity);
  const collection = addr(body.collection);
  const drop = await read(collection);
  const paid = drop.price > 0n;
  if (paid && !isListableToken(drop.paymentToken)) throw new IntentRefusal("Unknown payment token");
  const calls: IntentCall[] = dropCalls
    .claim(collection, { quantity, proof: body.proof, price: drop.price, paymentToken: drop.paymentToken })
    .map(toIntentCall);
  if (paid) calls.push(...platformFeeCalls(ctx.appId, "launchpad", drop.paymentToken, drop.price * quantity, cfg));
  return { calls };
}

export type DropManageAction = "issue" | "set_allowlist_root";

export async function buildDropManageIntent(
  body: { owner: string; collection: string; action: DropManageAction; recipient?: string; quantity?: string; root?: string },
  read: DropReader = chainDrop,
) {
  const collection = addr(body.collection);
  if (body.action === "issue") {
    if (!body.recipient) throw new IntentRefusal("recipient is required");
    batchQuantity(body.quantity);
  } else if (!body.root) {
    throw new IntentRefusal("root is required");
  }
  const drop = await read(collection);
  if (addr(body.owner) !== drop.organizer) throw new IntentRefusal("Only the drop's organizer can manage it");
  if (body.action === "issue") {
    const quantity = batchQuantity(body.quantity);
    if (drop.maxSupply !== 0n && drop.totalMinted + quantity > drop.maxSupply) throw new IntentRefusal("Not enough supply left");
    return { calls: [toIntentCall(dropCalls.issue(collection, body.recipient!, quantity))] };
  }
  return { calls: [toIntentCall(dropCalls.setAllowlistRoot(collection, body.root!))] };
}

export type PopManageAction = "issue" | "set_allowlist_root";

export async function buildPopManageIntent(body: {
  owner: string;
  collection: string;
  action: PopManageAction;
  recipient?: string;
  tokenUri?: string;
  root?: string;
}) {
  const collection = addr(body.collection);
  if (body.action === "issue") {
    if (!body.recipient) throw new IntentRefusal("recipient is required");
    const calls: IntentCall[] = [{ contractAddress: collection, entrypoint: "issue", calldata: [addr(body.recipient), ...encodeByteArray(body.tokenUri ?? "")] }];
    return { calls };
  }
  if (!body.root) throw new IntentRefusal("root is required");
  const calls: IntentCall[] = [{ contractAddress: collection, entrypoint: "set_allowlist_root", calldata: [body.root] }];
  return { calls };
}
