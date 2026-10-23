import { z } from "zod";

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function pageQuery(opts: { defaultLimit?: number; maxLimit?: number } = {}) {
  const defaultLimit = opts.defaultLimit ?? 20;
  const maxLimit = opts.maxLimit ?? 100;
  return z
    .object({ page: z.unknown(), limit: z.unknown() })
    .transform(({ page: rawPage, limit: rawLimit }) => {
      const page = clampInt(rawPage, 1, 1, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(rawLimit, defaultLimit, 1, maxLimit);
      return { page, limit, skip: (page - 1) * limit };
    });
}
