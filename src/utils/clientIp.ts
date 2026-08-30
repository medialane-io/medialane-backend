const TRUSTED_APP_HEADER = "x-medialane-client-ip";

export function clientIp(req: Request): string {
  const fromApp = req.headers.get(TRUSTED_APP_HEADER)?.trim();
  if (fromApp) return fromApp;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }

  return "unknown";
}
