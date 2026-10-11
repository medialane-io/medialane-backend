import { Contract, cairo } from "starknet";
import { getListableTokens, type ResolvedFeeConfig } from "@medialane/sdk";
import { DropCollectionABI, encodeByteArray } from "@medialane/sdk/starknet";
import { normalizeAddress, createProvider } from "../../utils/starknet.js";
import { platformFeeCalls, platformFeeConfig, type IntentBuildContext, type IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const u256 = (v: string | bigint): [string, string] => {
  const u = cairo.uint256(BigInt(v));
  return [String(u.low), String(u.high)];
};

export type DropConditionsReader = (collection: string) => Promise<{ price: bigint; paymentToken: string }>;

export const chainDropConditions: DropConditionsReader = async (collection) => {
  const col = new Contract({ abi: DropCollectionABI as never, address: addr(collection), providerOrAccount: createProvider() as never });
  const cond = (await col.call("get_claim_conditions", [])) as { price: bigint; payment_token: bigint | string };
  const token = typeof cond.payment_token === "bigint" ? "0x" + cond.payment_token.toString(16) : String(cond.payment_token);
  return { price: BigInt(cond.price), paymentToken: token };
};

export async function buildPopClaimIntent(body: { claimer: string; collection: string; proof: string[] }) {
  const calls: IntentCall[] = [{ contractAddress: addr(body.collection), entrypoint: "claim", calldata: [String(body.proof.length), ...body.proof] }];
  return { calls };
}

export async function buildPopBurnIntent(body: { owner: string; collection: string; tokenId: string }) {
  const calls: IntentCall[] = [{ contractAddress: addr(body.collection), entrypoint: "burn", calldata: u256(body.tokenId) }];
  return { calls };
}

export async function buildDropClaimIntent(
  body: { claimer: string; collection: string },
  ctx: IntentBuildContext = { appId: "" },
  read: DropConditionsReader = chainDropConditions,
  cfg: ResolvedFeeConfig = platformFeeConfig,
) {
  const collection = addr(body.collection);
  const { price, paymentToken } = await read(collection);
  const paid = price > 0n && BigInt(paymentToken) !== 0n;
  const calls: IntentCall[] = [];
  if (paid) {
    const token = getListableTokens().find((t) => addr(t.address) === addr(paymentToken));
    if (!token) throw new IntentRefusal("Unknown payment token");
    calls.push({ contractAddress: addr(token.address), entrypoint: "approve", calldata: [collection, ...u256(price)] });
  }
  calls.push({ contractAddress: collection, entrypoint: "claim", calldata: ["1", "0"] });
  if (paid) calls.push(...platformFeeCalls(ctx.appId, "launchpad", addr(paymentToken), price, cfg));
  return { calls };
}

export async function buildDropAllowlistIntent(body: { owner: string; collection: string; addresses: string[] }) {
  const collection = addr(body.collection);
  const list = body.addresses.map(addr);
  const calls: IntentCall[] = [
    { contractAddress: collection, entrypoint: "set_allowlist_enabled", calldata: ["1"] },
    { contractAddress: collection, entrypoint: "batch_add_to_allowlist", calldata: [String(list.length), ...list] },
  ];
  return { calls };
}

export type DropManageAction = "allowlist_enabled" | "allowlist_add" | "allowlist_remove" | "withdraw_payments";

export async function buildDropManageIntent(body: {
  owner: string;
  collection: string;
  action: DropManageAction;
  enabled?: boolean;
  addresses?: string[];
  address?: string;
}) {
  const collection = addr(body.collection);
  const call = (entrypoint: string, calldata: string[]): { calls: IntentCall[] } => ({ calls: [{ contractAddress: collection, entrypoint, calldata }] });
  switch (body.action) {
    case "allowlist_enabled":
      if (body.enabled === undefined) throw new IntentRefusal("enabled is required");
      return call("set_allowlist_enabled", [body.enabled ? "1" : "0"]);
    case "allowlist_add": {
      if (!body.addresses?.length) throw new IntentRefusal("addresses are required");
      const list = body.addresses.map(addr);
      return call("batch_add_to_allowlist", [String(list.length), ...list]);
    }
    case "allowlist_remove":
      if (!body.address) throw new IntentRefusal("address is required");
      return call("remove_from_allowlist", [addr(body.address)]);
    case "withdraw_payments":
      return call("withdraw_payments", []);
  }
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
