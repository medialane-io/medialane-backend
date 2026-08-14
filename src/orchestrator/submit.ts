import { shortString } from "starknet";

type Call = { contractAddress: string; entrypoint: string; calldata: string[] };
type Message = Record<string, unknown>;

function toFelt(value: unknown): string {
  const s = String(value);
  if (s.startsWith("0x")) return s;
  try {
    return "0x" + BigInt(s).toString(16);
  } catch {
    return shortString.encodeShortString(s);
  }
}

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

  } else if (intentType === "CANCEL_ORDER") {

    last.calldata = [
      toFelt(message.order_hash),
      toFelt(message.offerer),
      ...sigCalldata,
    ];
  }

  return populated;
}
