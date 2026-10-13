import { z } from "zod";
import { MAX_FILE_BYTES } from "../steps.js";

const fileRef = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  type: z.string().max(120),
});

export const newCollectionFields = {
  name: z.string().min(1).max(80),
  symbol: z.string().min(1).max(12),
  description: z.string().max(500).optional(),
  image: fileRef.optional(),
  externalLink: z.string().url().regex(/^https?:\/\//).optional(),
};

export type FileRef = z.infer<typeof fileRef>;

export interface NewCollection {
  kind: "new";
  name: string;
  symbol: string;
  description?: string;
  image?: FileRef;
  externalLink?: string;
}

export function collectionImage(choice: { kind: string; image?: FileRef }, otherNames: string[]): FileRef | null {
  if (choice.kind !== "new" || !choice.image) return null;
  return otherNames.includes(choice.image.name) ? null : choice.image;
}
