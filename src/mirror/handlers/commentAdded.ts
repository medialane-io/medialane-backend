import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

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

  for (let j = 0; j < pendingWordLen; j++) {
    bytes[offset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const log = createLogger("mirror:commentAdded");

export async function handleCommentAdded(
  event: RawStarknetEvent,
  txHash: string,
  logIndex: number
): Promise<void> {
  try {
    const nftContract = normalizeAddress("STARKNET", event.keys[1]);
    const tokenIdLow = BigInt(event.keys[2]);
    const tokenIdHigh = BigInt(event.keys[3]);
    const tokenId = ((tokenIdHigh << 128n) | tokenIdLow).toString();
    const author = normalizeAddress("STARKNET", event.keys[4]);

    const tokenExists = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: nftContract, tokenId } },
      select: { id: true },
    });
    if (!tokenExists) {
      log.debug({ txHash, nftContract, tokenId }, "Comment skipped — token not indexed");
      return;
    }

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

    const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    if (!sanitized) return;

    await prisma.comment.upsert({
      where: { txHash_logIndex: { txHash, logIndex } },
      create: {
        chain: "STARKNET",
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
