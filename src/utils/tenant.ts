import prisma from "../db/client.js";

export const TENANT_SLUG_INPUT = [
  "MEDIALANE_DAPP",
  "MEDIALANE_STARKNET",
  "MEDIALANE_IO",
  "MEDIALANE_PORTAL",
  "MEDIALANE_DAO",
  "MEDIALANE_SDK",
] as const;

const ALIASES: Record<string, string> = {
  MEDIALANE_DAPP: "MEDIALANE_STARKNET",
};

export function normalizeTenantSlug(slug: string): string {
  const trimmed = slug.trim().toUpperCase();
  return ALIASES[trimmed] ?? trimmed;
}

const cache = new Map<string, string>();

export async function tenantIdForSlug(slug: string): Promise<string | null> {
  const normalized = normalizeTenantSlug(slug);
  const cached = cache.get(normalized);
  if (cached) return cached;

  const tenant = await prisma.tenant.findUnique({
    where: { slug: normalized },
    select: { id: true },
  });
  if (!tenant) return null;

  cache.set(normalized, tenant.id);
  return tenant.id;
}

export async function tenantSlugForId(id: string): Promise<string | null> {
  for (const [slug, cachedId] of cache) if (cachedId === id) return slug;

  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { slug: true } });
  if (!tenant) return null;

  cache.set(tenant.slug, id);
  return tenant.slug;
}

export async function requireTenant(slug: string): Promise<string> {
  const id = await tenantIdForSlug(slug);
  if (!id) throw new Error(`Unknown tenant: ${slug}`);
  return id;
}
