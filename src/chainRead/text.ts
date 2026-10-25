import { shortString } from "starknet";

const WORD_BYTES = 31;

function byteArrayText(felts: readonly string[], dataLen: number): string | null {
  const pendingWord = BigInt(felts[1 + dataLen]!);
  const pendingWordLen = Number(BigInt(felts[2 + dataLen]!));
  if (pendingWordLen > WORD_BYTES) return null;
  const bytes = new Uint8Array(dataLen * WORD_BYTES + pendingWordLen);
  let offset = 0;
  for (let i = 0; i < dataLen; i++) {
    const word = BigInt(felts[1 + i]!);
    for (let j = 0; j < WORD_BYTES; j++) {
      bytes[offset++] = Number((word >> BigInt((WORD_BYTES - 1 - j) * 8)) & 0xffn);
    }
  }
  for (let j = 0; j < pendingWordLen; j++) {
    bytes[offset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function feltArrayText(felts: readonly string[], dataLen: number): string {
  const words = felts.slice(1, 1 + dataLen);
  try {
    return words.map((felt) => shortString.decodeShortString(BigInt(felt).toString())).join("");
  } catch {
    return words.join("");
  }
}

function feltText(felt: string): string {
  const value = BigInt(felt);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.slice(i, i + 2), 16);
    if (byte !== 0) bytes.push(byte);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return shortString.decodeShortString(value.toString());
  }
}

export function decodeText(raw: readonly string[]): string | null {
  if (raw.length === 0) return null;
  try {
    const first = Number(BigInt(raw[0]!));
    const counted = Number.isSafeInteger(first) && first >= 0;
    if (counted && raw.length >= first + 3) return byteArrayText(raw, first);
    if (counted && raw.length > 1 && raw.length === first + 1) return feltArrayText(raw, first);
    if (raw.length === 1) return feltText(raw[0]!);
    return null;
  } catch {
    return null;
  }
}
