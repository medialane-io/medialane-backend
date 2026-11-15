import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";

const tooLarge = (c: Context) => c.json({ error: "Payload too large" }, 413);

export const requestBodyLimit = bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: tooLarge });
