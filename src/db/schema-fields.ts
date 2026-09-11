import { Prisma } from "@prisma/client";

export function fieldsOf(model: string): Set<string> {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!found) throw new Error(`No model named "${model}" in the schema`);
  return new Set(found.fields.map((f) => f.name));
}

export function unknownFields(model: string, data: Record<string, unknown>): string[] {
  const known = fieldsOf(model);
  return Object.keys(data).filter((key) => !known.has(key));
}

export function assertWritable(model: string, data: Record<string, unknown>): void {
  const unknown = unknownFields(model, data);
  if (unknown.length > 0) {
    throw new Error(`${model} has no field ${unknown.map((f) => `"${f}"`).join(", ")}`);
  }
}
