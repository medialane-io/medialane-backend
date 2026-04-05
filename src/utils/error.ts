/** Safely extract a message string from an unknown caught value.
 *  Strips Prisma-specific metadata so internal DB details never reach HTTP responses. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Prisma errors expose DB schema details (column names, enum types, constraint fields).
    // Return a generic message for all PrismaClient* error classes.
    if (err.constructor.name.startsWith("Prisma")) {
      return "Database error";
    }
    return err.message;
  }
  return "Internal error";
}
