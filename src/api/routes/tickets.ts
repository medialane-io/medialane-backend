import { Hono } from "hono";
import { cairo } from "starknet";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:tickets");

const tickets = new Hono<AppEnv>();

// GET /v1/tickets/:contract/:tokenId/validity/:wallet
// Pure on-chain read — calls is_valid(token_id, holder) on the IPTicketCollection.
// Returns { valid: boolean }: true iff holder has balance > 0 AND current time is
// within the ticket's validity window (or the window is open).
tickets.get("/:contract/:tokenId/validity/:wallet", async (c) => {
  const contract = normalizeAddress("STARKNET", c.req.param("contract"));
  const wallet = normalizeAddress("STARKNET", c.req.param("wallet"));
  const tokenIdRaw = c.req.param("tokenId");

  let tokenIdU256: { low: bigint; high: bigint };
  try {
    const u = cairo.uint256(tokenIdRaw);
    tokenIdU256 = { low: BigInt(u.low), high: BigInt(u.high) };
  } catch {
    return c.json({ error: "Invalid tokenId" }, 400);
  }

  try {
    const res = await callRpc((provider) =>
      provider.callContract({
        contractAddress: contract,
        entrypoint: "is_valid",
        calldata: [
          tokenIdU256.low.toString(),
          tokenIdU256.high.toString(),
          wallet,
        ],
      }),
    );
    // is_valid returns a Cairo bool: 0 = false, 1 = true
    const valid = res.length > 0 && BigInt(res[0] ?? "0x0") !== 0n;
    return c.json({ data: { valid } });
  } catch (err) {
    log.error({ err, contract, tokenId: tokenIdRaw, wallet }, "is_valid RPC call failed");
    return c.json({ error: "Failed to check ticket validity — RPC error" }, 503);
  }
});

export default tickets;
