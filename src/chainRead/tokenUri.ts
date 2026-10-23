import { callEither, u256Calldata, type CallContract } from "./call.js";
import { decodeText } from "./text.js";

const PROBE_ORDER = ["token_uri", "tokenURI", "uri"] as const;

const answering = new Map<string, string>();

type CollectionKind = { standard: string | null; service: string | null } | null;

const isOwn = (col: CollectionKind): col is NonNullable<CollectionKind> =>
  col != null && !col.service?.startsWith("external-");

function resolveErc1155Uri(template: string, tokenId: string): string {
  if (!template.includes("{id}")) return template;
  return template.replace("{id}", BigInt(tokenId).toString(16).padStart(64, "0"));
}

export async function readTokenUri(
  call: CallContract,
  contractAddress: string,
  tokenId: string,
  col: CollectionKind,
): Promise<string | null> {
  const calldata = u256Calldata(tokenId);
  const own = isOwn(col);
  const remembered = own ? undefined : answering.get(contractAddress);
  const candidates = own
    ? [col.standard === "ERC1155" ? "uri" : "token_uri"]
    : [...(remembered ? [remembered] : []), ...PROBE_ORDER.filter((e) => e !== remembered)];

  for (const entrypoint of candidates) {
    const raw = await callEither(call, contractAddress, [entrypoint], calldata);
    const text = raw ? decodeText(raw) : null;
    if (text) {
      if (!own) answering.set(contractAddress, entrypoint);
      return entrypoint === "uri" ? resolveErc1155Uri(text, tokenId) : text;
    }
    if (entrypoint === remembered) answering.delete(contractAddress);
  }
  return null;
}
