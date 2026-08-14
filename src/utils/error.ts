
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {

    if (err.constructor.name.startsWith("Prisma")) {
      return "Database error";
    }
    return err.message;
  }
  return "Internal error";
}
