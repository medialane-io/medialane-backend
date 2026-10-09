import { z } from "zod";
import { GAS, MAX_RUN_ITEMS, batchSizes, type CostTable, type PlannedStep } from "../../steps.js";
import { fileRef, collection, terms, type RunServiceDefinition } from "../shared-spec.js";
import { nextStep, readProgress, runInFlight } from "./progress.js";

const spec = z.object({
  collection,
  terms,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  artwork: fileRef.optional(),
  guests: z.array(z.string().email()).min(1).max(MAX_RUN_ITEMS),
});

export type CertificateEmissionSpec = z.infer<typeof spec>;

export const CERTIFICATE_EMISSION_COSTS: CostTable = {
  collection: [{ action: "intent:create-collection", per: "step" }, ...GAS],
  file: [{ action: "metadata:upload-file", per: "step" }],
  metadata: [{ action: "metadata:upload-json", per: "step" }],
  wallet: [
    { action: "wallet:deploy", per: "step" },
    { action: "paymaster:deploy-build", per: "step" },
    { action: "paymaster:deploy-execute", per: "step" },
  ],
  emission: [{ action: "issuance:emission", per: "item" }, ...GAS],
};

export const certificateEmission: RunServiceDefinition<CertificateEmissionSpec> = {
  parseSpec(raw) {
    const parsed = spec.parse(raw);
    const guests = new Set(parsed.guests.map((g) => g.trim().toLowerCase()));
    return { ...parsed, guests: [...guests] };
  },
  costs: CERTIFICATE_EMISSION_COSTS,
  plan(value, { provisioned }) {
    const steps: PlannedStep[] = [];
    if (value.artwork) steps.push({ kind: "file", items: 1 });
    steps.push({ kind: "metadata", items: 1 });
    if (value.collection.kind === "new") steps.push({ kind: "collection", items: 0 });
    for (let i = 0; i < Math.max(0, value.guests.length - provisioned); i++) steps.push({ kind: "wallet", items: 1 });
    for (const size of batchSizes(value.guests.length)) steps.push({ kind: "emission", items: size });
    return steps;
  },
  guests: (value) => value.guests,
  initialProgress: () => ({ wallets: {}, batches: {} }),
  nextStep: (value, progress) => nextStep(value, readProgress(progress)),
  inFlight: (progress) => runInFlight(readProgress(progress)),
};
