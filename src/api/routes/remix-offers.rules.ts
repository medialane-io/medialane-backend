import type { OnChainOrderDetails } from "../../types/marketplace.js";

export type RemixStandard = "ERC721" | "ERC1155";

export interface RemixLink {
  remixContract: string;
  remixTokenId: string;
  orderHash: string;
}

export interface RemixLinkDeps {
  collectionStandard(contract: string): Promise<RemixStandard | null>;
  ownsToken(contract: string, tokenId: string, owner: string, standard: RemixStandard): Promise<boolean>;
  orderDetails(orderHash: string, standard: RemixStandard): Promise<OnChainOrderDetails>;
}

export type RemixLinkVerdict = { ok: true } | { ok: false; status: 403 | 422 | 503; error: string };

export function isParticipant(
  offer: { creatorAddress: string; requesterAddress: string | null },
  callerWallet?: string,
): boolean {
  return callerWallet !== undefined && (offer.creatorAddress === callerWallet || offer.requesterAddress === callerWallet);
}

const RETRY = "Could not verify this on-chain, please retry";

function parseTokenId(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function sameTokenId(a: string, b: string): boolean {
  const left = parseTokenId(a);
  return left !== null && left === parseTokenId(b);
}

export async function verifyRemixLink(
  deps: RemixLinkDeps,
  caller: string,
  link: RemixLink,
): Promise<RemixLinkVerdict> {
  if (parseTokenId(link.remixTokenId) === null) {
    return { ok: false, status: 422, error: "Invalid remix token id" };
  }

  const standard = await deps.collectionStandard(link.remixContract);
  if (!standard) return { ok: false, status: 422, error: "Remix collection not found" };

  let owns: boolean;
  let order: OnChainOrderDetails;
  try {
    owns = await deps.ownsToken(link.remixContract, link.remixTokenId, caller, standard);
    if (!owns) return { ok: false, status: 403, error: "You do not hold this remix token" };
    order = await deps.orderDetails(link.orderHash, standard);
  } catch {
    return { ok: false, status: 503, error: RETRY };
  }

  if (order.offerer !== caller) return { ok: false, status: 403, error: "That listing is not yours" };
  if (order.offerToken !== link.remixContract || !sameTokenId(order.offerIdentifier, link.remixTokenId)) {
    return { ok: false, status: 422, error: "That listing is not for this remix token" };
  }
  return { ok: true };
}
