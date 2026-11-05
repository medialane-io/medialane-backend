import type { Call } from "starknet";
import { sameCalls, typedDataMatches } from "@medialane/sdk/starknet";

export class IntentMismatch extends Error {
  constructor() {
    super("The submitted build does not match the request");
    this.name = "IntentMismatch";
  }
}

export function assertMatchesClientBuild(clientBuilt: unknown, server: { calls: unknown; typedData?: unknown }): void {
  if (clientBuilt === undefined) return;
  const client = clientBuilt as { calls: Call[]; typedData?: unknown };
  if (!sameCalls(client.calls, server.calls as Call[]) || !typedDataMatches(client.typedData, server.typedData)) {
    throw new IntentMismatch();
  }
}
