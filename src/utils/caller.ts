export const DEFAULT_APP = "MEDIALANE_API";
export const IO_APP = "MEDIALANE_IO";

export function callerApp(c: { get(key: "appId"): string | undefined }): string {
  return c.get("appId") ?? DEFAULT_APP;
}
