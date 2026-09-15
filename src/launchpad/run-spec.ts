import { z } from "zod";

export const RUN_SERVICES = ["data-tokenization-erc721", "ip-ticketing"] as const;
export type RunService = (typeof RUN_SERVICES)[number];

export const MAX_RUN_ITEMS = 500;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const fileRef = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  type: z.string().max(120),
});

const terms = z.object({
  licenseType: z.string().min(1).max(40),
  commercialUse: z.enum(["Yes", "No"]),
  derivatives: z.enum(["Allowed", "Not Allowed", "Share-Alike"]),
  attribution: z.enum(["Required", "Not Required"]),
  territory: z.string().min(1).max(40),
  aiPolicy: z.enum(["Allowed", "Training Only", "Not Allowed"]),
  royalty: z.number().min(0).max(50),
});

const collection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), collectionId: z.string().min(1), contractAddress: z.string().min(1) }),
  z.object({ kind: z.literal("new"), name: z.string().min(1).max(80), symbol: z.string().min(1).max(12) }),
]);

const dataTokenizationSpec = z
  .object({
    collection,
    terms,
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          description: z.string().max(2000).default(""),
          ipType: z.string().min(1).max(40),
          placement: z.enum(["image", "animation", "document"]),
          file: fileRef,
          image: fileRef.optional(),
          traits: z
            .array(z.object({ traitType: z.string().min(1).max(64), value: z.string().min(1).max(512) }))
            .max(20)
            .default([]),
        }),
      )
      .min(1)
      .max(MAX_RUN_ITEMS),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.items.forEach((item, index) => {
      if (item.placement !== "image" && !item.image) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "image"], message: "This item needs a cover image" });
      }
      if (item.placement === "image" && !item.file.type.startsWith("image/")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "file"], message: "This item's file needs to be an image" });
      }
      if (seen.has(item.file.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "file", "name"], message: "Each item needs its own file" });
      }
      seen.add(item.file.name);
    });
  });

const ipTicketingSpec = z.object({
  collection,
  terms: terms.extend({ transferable: z.enum(["Allowed", "Not Allowed"]) }),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  artwork: fileRef.optional(),
  validFrom: z.number().int().positive().optional(),
  validUntil: z.number().int().positive().optional(),
  supply: z.number().int().positive().optional(),
  guests: z.array(z.string().email()).min(1).max(MAX_RUN_ITEMS),
});

export type DataTokenizationSpec = z.infer<typeof dataTokenizationSpec>;
export type IpTicketingSpec = z.infer<typeof ipTicketingSpec>;
export type RunSpec =
  | { service: "data-tokenization-erc721"; spec: DataTokenizationSpec }
  | { service: "ip-ticketing"; spec: IpTicketingSpec };

export function parseRunSpec(service: string, spec: unknown): RunSpec {
  if (service === "data-tokenization-erc721") {
    return { service, spec: dataTokenizationSpec.parse(spec) };
  }
  if (service === "ip-ticketing") {
    const parsed = ipTicketingSpec.parse(spec);
    const guests = new Set(parsed.guests.map((g) => g.trim().toLowerCase()));
    if (parsed.supply !== undefined && parsed.supply < guests.size) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["supply"], message: "Supply must cover every guest" }]);
    }
    if (parsed.validFrom !== undefined && parsed.validUntil !== undefined && parsed.validUntil <= parsed.validFrom) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "It has to end after it starts" }]);
    }
    return { service, spec: { ...parsed, guests: [...guests] } };
  }
  throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["service"], message: `Unknown service ${service}` }]);
}
