import { Contract, cairo } from "starknet";
import { getListableTokens, type ResolvedFeeConfig } from "@medialane/sdk";
import { DropCollectionABI } from "@medialane/sdk/starknet";
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
