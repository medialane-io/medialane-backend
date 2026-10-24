import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "@medialane/sdk";
import { newCollectionFields } from "./collection-metadata.js";

export const fileRef = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  type: z.string().max(120),
});

export const terms = z.object({
  licenseType: z.string().min(1),
  commercialUse: z.string().min(1),
  derivatives: z.string().min(1),
  attribution: z.string().min(1),
  territory: z.string().min(1),
  aiPolicy: z.string().min(1),
  royalty: z.number().min(0).max(100),
});

export const collection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), collectionId: z.string().min(1), contractAddress: z.string().min(1) }),
  z.object({ kind: z.literal("new"), ...newCollectionFields }),
]);

export interface PlanContext {
  provisioned: number;
}

export interface RunServiceDefinition<Spec> {
  parseSpec(raw: unknown): Spec;
  costs: import("../steps.js").CostTable;
  plan(spec: Spec, context: PlanContext): import("../steps.js").PlannedStep[];
  guests(spec: Spec): string[];
  initialProgress(): unknown;
  nextStep?(spec: Spec, progress: unknown): unknown;
  inFlight(progress: unknown): boolean;
}
