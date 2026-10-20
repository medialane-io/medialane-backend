/** The token's description to store: null when it is empty or a copy of its collection's description. */
export function ownDescription(description: unknown, collectionDescription: string | null | undefined): string | null {
  if (typeof description !== "string") return null;
  const text = description.trim();
  if (!text) return null;
  if (collectionDescription && text === collectionDescription.trim()) return null;
  return description;
}
