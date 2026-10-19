import { Hono } from "hono";
import { resolveMetadata } from "../../discovery/index.js";
import { fetchTokenUri } from "../../orchestrator/metadata.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { decodeImageDataUri, isInlineContent } from "../../utils/onchainContent.js";

const media = new Hono();

const CONTRACT = /^0x[0-9a-fA-F]{1,64}$/;
const TOKEN_ID = /^\d{1,78}$/;

media.get("/:chain/:contract/:tokenId/image", async (c) => {
  const { chain, contract, tokenId } = c.req.param();
  if (chain !== "starknet" || !CONTRACT.test(contract) || !TOKEN_ID.test(tokenId)) return c.notFound();

  const tokenUri = await fetchTokenUri(normalizeAddress("STARKNET", contract), tokenId, "STARKNET").catch(() => null);
  if (!isInlineContent(tokenUri)) return c.notFound();

  const metadata = await resolveMetadata(tokenUri);
  const image = typeof metadata?.image === "string" ? decodeImageDataUri(metadata.image) : null;
  if (!image) return c.notFound();

  return c.body(image.bytes, 200, {
    "Content-Type": image.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "X-Content-Type-Options": "nosniff",
  });
});

export default media;
