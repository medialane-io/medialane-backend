import { z } from "zod";
import { GAS, MAX_RUN_ITEMS, batchSizes, type CostTable, type PlannedStep } from "../../steps.js";
import { collection, fileRef, terms, type RunServiceDefinition } from "../shared-spec.js";

const spec = z.object({
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

export type IpTicketingSpec = z.infer<typeof spec>;

export const IP_TICKETING_COSTS: CostTable = {
  collection: [{ action: "intent:create-collection", per: "step" }, ...GAS],
  file: [{ action: "metadata:upload-file", per: "step" }],
  metadata: [{ action: "metadata:upload-json", per: "step" }],
  tier: [{ action: "intent:create-tier", per: "step" }, ...GAS],
  wallet: [
    { action: "wallet:deploy", per: "step" },
    { action: "paymaster:deploy-build", per: "step" },
    { action: "paymaster:deploy-execute", per: "step" },
  ],
  emission: [{ action: "issuance:emission", per: "item" }, ...GAS],
};

export const ipTicketing: RunServiceDefinition<IpTicketingSpec> = {
  parseSpec(raw) {
    const parsed = spec.parse(raw);
    const guests = new Set(parsed.guests.map((g) => g.trim().toLowerCase()));
    if (parsed.supply !== undefined && parsed.supply < guests.size) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["supply"], message: "Supply must cover every guest" }]);
    }
    if (parsed.validFrom !== undefined && parsed.validUntil !== undefined && parsed.validUntil <= parsed.validFrom) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "It has to end after it starts" }]);
    }
    return { ...parsed, guests: [...guests] };
  },
  costs: IP_TICKETING_COSTS,
  plan(value, { provisioned }) {
    const steps: PlannedStep[] = [];
    if (value.collection.kind === "new") steps.push({ kind: "collection", items: 0 });
    if (value.artwork) steps.push({ kind: "file", items: 1 });
    steps.push({ kind: "metadata", items: 1 });
    steps.push({ kind: "tier", items: 0 });
    for (let i = 0; i < Math.max(0, value.guests.length - provisioned); i++) steps.push({ kind: "wallet", items: 1 });
    for (const size of batchSizes(value.guests.length)) steps.push({ kind: "emission", items: size });
    return steps;
  },
  guests: (value) => value.guests,
  initialProgress: () => ({}),
  inFlight: () => false,
};
