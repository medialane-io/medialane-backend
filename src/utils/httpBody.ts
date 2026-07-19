/**
 * Read a fetch Response body as text, capped at `maxBytes`.
 *
 * `res.json()` / `res.text()` buffer the ENTIRE body into memory before any
 * limit can be applied — a hostile or broken endpoint returning a multi-GB
 * body can exhaust the process. This streams the body and stops once the cap
 * is reached, returning whatever was read plus a `truncated` flag so the
 * caller decides whether a truncated body is usable (webhook: store the first
 * N bytes) or a hard failure (metadata JSON: reject — a partial object won't
 * parse anyway).
 *
 * A `Content-Length` larger than the cap short-circuits before reading a byte.
 */
export async function readTextCapped(
  res: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { text: "", truncated: true };
  }

  if (!res.body) return { text: "", truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      const keep = maxBytes - (total - value.length);
      if (keep > 0) chunks.push(value.subarray(0, keep));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buf.toString("utf-8"), truncated };
}
