import { z } from "zod";

const attributeSchema = z.object({
  trait_type: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  display_type: z.string().optional(),
}).passthrough();

export const attributesArraySchema = z.array(attributeSchema);

export type MetadataAttribute = z.infer<typeof attributeSchema>;

export function metadataAttributes(metadata: Record<string, unknown> | null): MetadataAttribute[] | null {
  const parsed = attributesArraySchema.safeParse(metadata?.attributes);
  return parsed.success ? parsed.data : null;
}
