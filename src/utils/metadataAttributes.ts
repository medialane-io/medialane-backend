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

export interface TokenFields {
  ipType: string | null;
  licenseType: string | null;
  commercialUse: boolean | null;
  author: string | null;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function field<T>(metadata: Record<string, unknown> | null, key: string, guard: (value: unknown) => value is T): T | null {
  const properties = metadata?.properties;
  const nested =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[key]
      : undefined;
  if (guard(nested)) return nested;
  const top = metadata?.[key];
  return guard(top) ? top : null;
}

function trait(attrs: readonly MetadataAttribute[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = attrs.find((a) => a.trait_type.toLowerCase() === wanted);
  return isString(found?.value) ? found.value : null;
}

export function tokenFields(metadata: Record<string, unknown> | null, attrs: readonly MetadataAttribute[]): TokenFields {
  return {
    ipType: field(metadata, "ip_type", isString) ?? trait(attrs, "ip type"),
    licenseType: field(metadata, "license_type", isString) ?? trait(attrs, "license"),
    commercialUse: field(metadata, "commercial_use", isBoolean),
    author: field(metadata, "author", isString),
  };
}
