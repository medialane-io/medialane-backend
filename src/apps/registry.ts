import { IO_VERIFICATION_DAYS } from "../utils/accountLifecycle.js";

export interface AppDefinition {
  name: string;
  displayName: string;
  emailConfirmDays: number | null;
}

export const FIRST_PARTY_APPS: readonly AppDefinition[] = [
  { name: "MEDIALANE_IO", displayName: "Medialane.io", emailConfirmDays: IO_VERIFICATION_DAYS },
  { name: "MEDIALANE_STARKNET", displayName: "Medialane", emailConfirmDays: null },
  { name: "MEDIALANE_PORTAL", displayName: "Medialane Portal", emailConfirmDays: null },
  { name: "MEDIALANE_DAO", displayName: "Medialane DAO", emailConfirmDays: null },
];

export function appByName(name: string): AppDefinition | undefined {
  return FIRST_PARTY_APPS.find((app) => app.name === name);
}
