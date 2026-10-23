import { zValidator } from "@hono/zod-validator";
import type { ZodTypeAny } from "zod";
import { badRequest } from "./errors.js";

export const validated = <T extends "json" | "query", S extends ZodTypeAny>(
  target: T,
  schema: S,
  opts: { message?: string } = {},
) =>
  zValidator(target, schema, (result) => {
    if (result.success) return;
    if (opts.message) throw badRequest(opts.message);
    throw badRequest(target === "json" ? "Invalid body" : "Invalid query", { details: result.error.flatten() });
  });
