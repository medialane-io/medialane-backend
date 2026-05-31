import { shortString } from "starknet";

type Call = { contractAddress: string; entrypoint: string; calldata: string[] };
type Message = Record<string, unknown>;

/**
 * Convert a value from the SNIP-12 typed data message into a Starknet
 * calldata felt string.
 *  - Already-hex values (0x…) pass through unchanged.
 *  - Plain decimal strings convert to hex.
 *  - Short strings (e.g. "ERC721") are encoded as Cairo felt252.
 */
function toFelt(value: unknown): string {
  const s = String(value);
  if (s.startsWith("0x")) return s;
  try {
    return "0x" + BigInt(s).toString(16);
  } catch {
    return shortString.encodeShortString(s);
  }
}

/**
 * Given a signed intent, populate the last marketplace call's calldata
 * with the serialized message fields and the SNIP-12 signature so the
 * client can submit the transaction directly without additional assembly.
 *
 * Only the final call in the array (register_order / fulfill_order /
 * cancel_order) is modified; approve calls are already fully populated.
 */
export function buildPopulatedCalls(
  intentType: string,
  message: Message,
  calls: Call[],
  signature: string[]
): Call[] {
  const populated = calls.map((c) => ({ ...c, calldata: [...c.calldata] }));
  const last = populated[populated.length - 1];
  const sig = signature.map(toFelt);
  const sigCalldata = [sig.length.toString(), ...sig];

  if (intentType === "CREATE_LISTING" || intentType === "MAKE_OFFER" || intentType === "COUNTER_OFFER") {
    // ERC-721 and audited ERC-1155 both use nested OrderParameters:
    // register_order(order: Order, signature: Span<felt252>)
    // Field order MUST match the Cairo OrderParameters struct exactly (redesigned
    // venues): offerer, marketplace, offer{item_type,token,id,amount},
    // consideration{...,amount,recipient}, royalty_max_bps, start_time, end_time,
    // salt, counter. Single `amount` per leg; no end_amount; nonce → counter.
    const o = message.offer as Message;
    const cns = message.consideration as Message;
    last.calldata = [
      toFelt(message.offerer),
      toFelt(message.marketplace),
      toFelt(o.item_type),
      toFelt(o.token),
      toFelt(o.identifier_or_criteria),
      toFelt(o.amount),
      toFelt(cns.item_type),
      toFelt(cns.token),
      toFelt(cns.identifier_or_criteria),
      toFelt(cns.amount),
      toFelt(cns.recipient),
      toFelt(message.royalty_max_bps),
      toFelt(message.start_time),
      toFelt(message.end_time),
      toFelt(message.salt),
      toFelt(message.counter),
      ...sigCalldata,
    ];
    // FULFILL_ORDER is no longer signed (caller is the fulfiller) — its calldata
    // is populated at intent-build time, so it never reaches buildPopulatedCalls.
  } else if (intentType === "CANCEL_ORDER") {
    // cancel_order(cancellation: OrderCancellation, signature: Span<felt252>) — no nonce
    last.calldata = [
      toFelt(message.order_hash),
      toFelt(message.offerer),
      ...sigCalldata,
    ];
  }

  return populated;
}
