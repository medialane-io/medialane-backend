import { z } from "zod";
import { MAX_FILE_BYTES } from "../steps.js";

export const fileRef = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  type: z.string().max(120),
});

export const terms = z.object({
  licenseType: z.string().min(1).max(40),
  commercialUse: z.enum(["Yes", "No"]),
  derivatives: z.enum(["Allowed", "Not Allowed", "Share-Alike"]),
  attribution: z.enum(["Required", "Not Required"]),
  territory: z.string().min(1).max(40),
  aiPolicy: z.enum(["Allowed", "Training Only", "Not Allowed"]),
  royalty: z.number().min(0).max(50),
});

export const collection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), collectionId: z.string().min(1), contractAddress: z.string().min(1) }),
  z.object({ kind: z.literal("new"), name: z.string().min(1).max(80), symbol: z.string().min(1).max(12) }),
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
