import { z } from "zod";
import { GAS, MAX_RUN_ITEMS, batchSizes, type CostTable, type PlannedStep } from "../../steps.js";
import { collection, fileRef, terms, type RunServiceDefinition } from "../shared-spec.js";
import { emptyProgress, expectedFiles, nextStep, readProgress, runInFlight } from "./progress.js";

const spec = z
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
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
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

export type DataTokenizationSpec = z.infer<typeof spec>;

export const DATA_TOKENIZATION_COSTS: CostTable = {
  collection: [{ action: "intent:create-collection", per: "step" }, ...GAS],
  file: [{ action: "metadata:upload-file", per: "step" }],
  metadata: [{ action: "metadata:upload-json", per: "step" }],
  batch: [{ action: "intent:mint", per: "item" }, ...GAS],
};

export const dataTokenization: RunServiceDefinition<DataTokenizationSpec> = {
  parseSpec: (raw) => spec.parse(raw),
  costs: DATA_TOKENIZATION_COSTS,
  plan(value) {
    const steps: PlannedStep[] = [];
    if (value.collection.kind === "new") steps.push({ kind: "collection", items: 0 });
    for (let i = 0; i < expectedFiles(value).size; i++) steps.push({ kind: "file", items: 1 });
    for (let i = 0; i < value.items.length; i++) steps.push({ kind: "metadata", items: 1 });
    for (const size of batchSizes(value.items.length)) steps.push({ kind: "batch", items: size });
    return steps;
  },
  guests: () => [],
  initialProgress: emptyProgress,
  nextStep: (value, progress) => nextStep(value, readProgress(progress)),
  inFlight: (progress) => runInFlight(readProgress(progress)),
};
