import { Hono } from "hono";
import { createLogger } from "../../../utils/logger.js";
import { z } from "zod";
import prisma from "../../../db/client.js";
import { normalizeAddress, callRpc } from "../../../utils/starknet.js";
import { upsertCoin, readTotalSupply } from "../../../utils/coin.js";
import { UNRUG_FACTORY_CONTRACT } from "../../../config/constants.js";
import { shortString } from "starknet";
import { toErrorMessage } from "../../../utils/error.js";
import { buildAdminCoinWhere } from "../coins.filters.js";

const log = createLogger("routes:admin");

function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

export function registerCoinRoutes(admin: Hono) {

admin.post("/coins/add-external", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      contractAddress: z.string().min(3),
      owner: z.string().optional(),
      startBlock: z.number().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "contractAddress required" }, 400);

  if (!UNRUG_FACTORY_CONTRACT) return c.json({ error: "Unrug factory not configured" }, 503);
  const contractAddress = normalizeAddress("STARKNET", parsed.data.contractAddress);

  try {

    const verify = await callRpc((p) =>
      p.callContract({ contractAddress: UNRUG_FACTORY_CONTRACT, entrypoint: "is_memecoin", calldata: [contractAddress] })
    );
    const isMemecoin = verify.length > 0 && BigInt(verify[0] ?? "0x0") !== 0n;
    if (!isMemecoin) {
      return c.json({ error: "Address is not an unrug memecoin (is_memecoin = false)" }, 400);
    }

    const [nameRes, symbolRes, decRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "symbol", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "decimals", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");
    const decimals = decRes[0] != null ? Number(BigInt(decRes[0])) : 18;
    const totalSupply = await readTotalSupply(contractAddress).catch(() => null);

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress,
      service: "external-erc20",
      name,
      symbol,
      decimals,
      totalSupply,
      creator: parsed.data.owner ? normalizeAddress("STARKNET", parsed.data.owner) : null,
      startBlock: BigInt(parsed.data.startBlock ?? 0),
    });

    const coin = await prisma.coin.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    log.info({ contractAddress, name, symbol }, "External coin added via admin");
    return c.json({
      data: coin
        ? { ...coin, startBlock: coin.startBlock.toString() }
        : { contractAddress, service: "external-erc20", standard: "ERC20", name, symbol },
    }, 201);
  } catch (err) {
    log.error({ err, contractAddress }, "external coin add failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

admin.get("/coins", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20")));
  const where = buildAdminCoinWhere({
    service: c.req.query("service") || undefined,
    search: c.req.query("search") || undefined,
  });
  const [rows, total] = await Promise.all([
    prisma.coin.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.coin.count({ where }),
  ]);
  const coins = rows.map((coin) => ({ ...coin, startBlock: coin.startBlock.toString() }));
  return c.json({ coins, total, page, limit });
});

admin.patch("/coins/:contract", async (c) => {
  const contractAddress = normalizeAddress("STARKNET", c.req.param("contract"));
  const schema = z.object({
    name:        z.string().optional(),
    symbol:      z.string().optional(),
    description: z.string().optional(),
    image:       z.string().optional(),
    service:     z.string().optional(),
    creator:     z.string().optional(),
    isHidden:    z.boolean().optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);

  const updated = await prisma.coin.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    data: {
      ...parsed.data,
      ...(parsed.data.creator ? { creator: normalizeAddress("STARKNET", parsed.data.creator) } : {}),
    },
  });
  log.info({ contractAddress }, "Coin updated via admin");
  return c.json({ data: { contractAddress: updated.contractAddress, name: updated.name, symbol: updated.symbol, isHidden: updated.isHidden } });
});

admin.post("/coins/:contract/refresh", async (c) => {
  const contractAddress = normalizeAddress("STARKNET", c.req.param("contract"));
  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);

  try {
    const [nameRes, symbolRes, decRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "symbol", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "decimals", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");
    const decimals = decRes[0] != null ? Number(BigInt(decRes[0])) : coin.decimals;
    const totalSupply = await readTotalSupply(contractAddress).catch(() => coin.totalSupply);

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress,
      service: coin.service,
      name,
      symbol,
      decimals,
      totalSupply,
      creator: coin.creator,
      startBlock: coin.startBlock,
    });
    log.info({ contractAddress, name, symbol, decimals }, "Coin metadata refreshed via admin");
    return c.json({ data: { name, symbol, decimals } });
  } catch (err) {
    log.error({ err, contractAddress }, "coin refresh failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});
}
