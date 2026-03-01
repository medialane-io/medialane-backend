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

  if (intentType === "CREATE_LISTING" || intentType === "MAKE_OFFER") {
    // register_order(order: OrderParameters, signature: Span<felt252>)
    const o = message.offer as Message;
    const cns = message.consideration as Message;
    last.calldata = [
      toFelt(message.offerer),
      toFelt(o.item_type),
      toFelt(o.token),
      toFelt(o.identifier_or_criteria),
      toFelt(o.start_amount),
      toFelt(o.end_amount),
      toFelt(cns.item_type),
      toFelt(cns.token),
      toFelt(cns.identifier_or_criteria),
      toFelt(cns.start_amount),
      toFelt(cns.end_amount),
      toFelt(cns.recipient),
      toFelt(message.start_time),
      toFelt(message.end_time),
      toFelt(message.salt),
      toFelt(message.nonce),
      ...sigCalldata,
    ];
  } else if (intentType === "FULFILL_ORDER") {
    // fulfill_order(fulfillment: OrderFulfillment, signature: Span<felt252>)
    last.calldata = [
      toFelt(message.order_hash),
      toFelt(message.fulfiller),
      toFelt(message.nonce),
      ...sigCalldata,
    ];
  } else if (intentType === "CANCEL_ORDER") {
    // cancel_order(cancellation: OrderCancellation, signature: Span<felt252>)
    last.calldata = [
      toFelt(message.order_hash),
      toFelt(message.offerer),
      toFelt(message.nonce),
      ...sigCalldata,
    ];
  }

  return populated;
}
