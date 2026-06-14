import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../../db/client.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { createLogger } from "../../../utils/logger.js";
import { toErrorMessage } from "../../../utils/error.js";

const log = createLogger("routes:admin:services");

// Inline catalog — mirrors @medialane/sdk services/registry.ts (05-service-model §VI).
// Update when new services are added to the SDK registry.
const SERVICE_CATALOG = [
  { id: "mip-erc721",                    displayName: "IP Collection",                    standard: "ERC721"  },
  { id: "mip-erc1155",                   displayName: "NFT Editions",                     standard: "ERC1155" },
  { id: "ip-erc721",                     displayName: "Programmable IP (genesis)",         standard: "ERC721"  },
  { id: "pop-protocol",                  displayName: "POP Protocol",                     standard: "ERC721"  },
  { id: "drop-collection",               displayName: "Collection Drop",                  standard: "ERC721"  },
  { id: "medialane-marketplace-erc721",  displayName: "Medialane Marketplace (ERC-721)",  standard: "ERC721"  },
  { id: "medialane-marketplace-erc1155", displayName: "Medialane Marketplace (ERC-1155)", standard: "ERC1155" },
] as const;

const CreateSchema = z.object({
  serviceId: z.string().min(1),
  chain: z.string().min(1),
  contractAddress: z.string().min(1),
  startBlock: z.string().min(1),
  notes: z.string().optional(),
});

const UpdateSchema = z.object({
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export function registerServicesRoutes(admin: Hono) {
  // GET /admin/services/catalog — service list for the portal UI
  // Must be registered BEFORE /admin/services/:id to avoid route shadowing.
  admin.get("/services/catalog", (c) => {
    return c.json({ data: SERVICE_CATALOG });
  });

  // GET /admin/services — all registered contracts
  admin.get("/services", async (c) => {
    try {
      const contracts = await prisma.serviceContract.findMany({
        orderBy: [{ serviceId: "asc" }, { createdAt: "desc" }],
      });
      return c.json({ data: contracts });
    } catch (err) {
      log.error({ err }, "Failed to list service contracts");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /admin/services — register a deployed contract
  admin.post("/services", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.errors[0].message }, 400);
    }

    const { serviceId, chain, contractAddress, startBlock, notes } = parsed.data;
    try {
      const record = await prisma.serviceContract.create({
        data: {
          serviceId,
          chain,
          contractAddress: normalizeAddress("STARKNET", contractAddress),
          startBlock,
          notes,
        },
      });
      return c.json({ data: record }, 201);
    } catch (err) {
      log.error({ err }, "Failed to create service contract");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // PATCH /admin/services/:id — toggle active or update notes
  admin.patch("/services/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.errors[0].message }, 400);
    }

    const existing = await prisma.serviceContract.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);

    try {
      const updated = await prisma.serviceContract.update({
        where: { id },
        data: parsed.data,
      });
      return c.json({ data: updated });
    } catch (err) {
      log.error({ err }, "Failed to update service contract");
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });
}
