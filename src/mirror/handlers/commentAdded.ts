import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

/**
 * Decode a Cairo ByteArray serialization as UTF-8.
 * byteArray.stringFromByteArray from starknet.js is ASCII-only and throws on
 * multi-byte characters (Japanese, emoji, etc.). This implementation collects
 * all bytes from the felt252 chunks and decodes them with TextDecoder.
 *
 * Serialization format (array of hex felt strings):
 *   [0]           = data.len (number of 31-byte chunks)
 *   [1..dataLen]  = each chunk as felt252 (31 bytes, big-endian, MSB first)
 *   [1+dataLen]   = pending_word felt252
 *   [2+dataLen]   = pending_word_len (number of valid bytes in pending_word)
 */
function utf8FromByteArray(felts: string[]): string {
  const dataLen = Number(BigInt(felts[0]));
  const pendingWord = BigInt(felts[1 + dataLen]);
  const pendingWordLen = Number(BigInt(felts[2 + dataLen]));
  const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
  let offset = 0;
  for (let i = 0; i < dataLen; i++) {
    const value = BigInt(felts[1 + i]);
    for (let j = 0; j < 31; j++) {
      bytes[offset++] = Number((value >> BigInt((30 - j) * 8)) & 0xffn);
    }
  }
  // pending_word is right-aligned: bytes are at (pendingWordLen-1)*8 .. 0, NOT at (30-j)*8
  for (let j = 0; j < pendingWordLen; j++) {
    bytes[offset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const log = createLogger("mirror:commentAdded");

/**
 * Parse and persist a CommentAdded event.
 * Idempotent — upsert on (txHash, logIndex).
 *
 * Event key layout:
 *   keys[0] = selector("CommentAdded")
 *   keys[1] = nft_contract (felt252)
 *   keys[2] = token_id.low (felt252)   ← u256 split
 *   keys[3] = token_id.high (felt252)
 *   keys[4] = author (felt252)
 *
 * Event data layout:
 *   [...ByteArray felts..., timestamp]
 *   timestamp is the last felt; everything before it is the ByteArray.
 */
export async function handleCommentAdded(
  event: RawStarknetEvent,
  txHash: string,
  logIndex: number
): Promise<void> {
  try {
    const nftContract = normalizeAddress(event.keys[1]);
    const tokenIdLow = BigInt(event.keys[2]);
    const tokenIdHigh = BigInt(event.keys[3]);
    const tokenId = ((tokenIdHigh << 128n) | tokenIdLow).toString();
    const author = normalizeAddress(event.keys[4]);

    // Only index comments for tokens that exist on the platform
    const tokenExists = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: nftContract, tokenId } },
      select: { id: true },
    });
    if (!tokenExists) {
      log.debug({ txHash, nftContract, tokenId }, "Comment skipped — token not indexed");
      return;
    }

    // Timestamp is the last felt in data; everything before it is the ByteArray.
    const dataArr = event.data;
    const blockTimestamp = BigInt(parseInt(dataArr[dataArr.length - 1], 16));
    const byteArrayData = dataArr.slice(0, dataArr.length - 1);

    let content: string;
    try {
      content = utf8FromByteArray(byteArrayData);
    } catch {
      log.warn({ txHash, logIndex }, "Failed to decode ByteArray content — skipping");
      return;
    }

    const MAX_COMMENT_BYTES = 4096;
    if (Buffer.byteLength(content, "utf8") > MAX_COMMENT_BYTES) {
      log.warn({ txHash, logIndex }, "Comment exceeds size limit — skipping");
      return;
    }

    // Sanitize: strip null bytes and non-printable control characters
    const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    if (!sanitized) return;

    await prisma.comment.upsert({
      where: { txHash_logIndex: { txHash, logIndex } },
      create: {
        chain: "starknet",
        contractAddress: nftContract,
        tokenId,
        author,
        content: sanitized,
        txHash,
        blockNumber: BigInt(event.block_number ?? 0),
        blockTimestamp,
        logIndex,
      },
      update: {},
    });

    log.debug({ txHash, nftContract, tokenId, author }, "Comment indexed");
  } catch (err) {
    log.error({ err, txHash, logIndex }, "handleCommentAdded failed");
    throw err;
  }
}
