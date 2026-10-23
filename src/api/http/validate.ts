import { zValidator } from "@hono/zod-validator";
import type { Context, Next } from "hono";
import type { ZodError, ZodTypeAny } from "zod";
import { badRequest } from "./errors.js";

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

export const validated = <T extends "json" | "query", S extends ZodTypeAny>(
  target: T,
  schema: S,
  opts: { message?: string } = {},
) => {
  const refuse = (error: ZodError): never => {
    if (opts.message) throw badRequest(opts.message);
    throw badRequest(target === "json" ? "Invalid body" : "Invalid query", { details: error.flatten() });
  };

  const standard = zValidator(target, schema, (result) => {
    if (!result.success) refuse(result.error);
  });
  if (target !== "json") return standard;

  const whateverTheHeaderSays = async (c: Context, next: Next) => {
    if (JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) return standard(c as Parameters<typeof standard>[0], next);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw badRequest("Malformed JSON in request body");
      }
    }
    const result = schema.safeParse(raw);
    if (!result.success) refuse(result.error);
    c.req.addValidatedData("json", result.data);
    await next();
  };
  return whateverTheHeaderSays as typeof standard;
};
