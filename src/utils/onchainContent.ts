export function isInlineContent(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

export function storedTokenUri(uri: string | null | undefined): string | null {
  if (!uri || isInlineContent(uri)) return null;
  return uri;
}

export function storedImage(image: unknown): string | null {
  if (typeof image !== "string" || !image) return null;
  if (isInlineContent(image) && !image.startsWith("data:image/")) return null;
  return image;
}
