# Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three confirmed security vulnerabilities — wallet impersonation via unverified header, SSRF in metadata fetcher, and gated content URL leak via collection include param.

**Architecture:** All three fixes are surgical: (1) remove the unverified `x-wallet-address` path from `identityAuth` and replace affected routes with `requireClerkJwt`, (2) add a single SSRF guard call inside `resolveMetadata`, (3) add a `select` clause to the `?include=profile` DB query. No new abstractions needed.

**Tech Stack:** Bun, Hono, Prisma, TypeScript. No new dependencies for any fix. Verify with `curl` against `localhost:3000`.

---

## File Map

| File | Change |
|---|---|
| `src/api/middleware/identityAuth.ts` | Remove Path 2 (unverified `x-wallet-address`) |
| `src/api/routes/profiles.ts` | Replace `identityAuth` with `requireClerkJwt` on collection profile PATCH; replace bare `identityAuth` on creator profile PATCH |
| `src/api/routes/username-claims.ts` | Replace `identityAuth` with `requireClerkJwt` on POST |
| `src/api/routes/reports.ts` | Replace `identityAuth` with `requireClerkJwt` on POST |
| `src/api/routes/remix-offers.ts` | Replace `identityAuth` with `requireClerkJwt` on write routes |
| `src/api/routes/users.ts` | Replace `identityAuth` with `requireClerkJwt` on POST /me |
| `src/discovery/index.ts` | Add SSRF guard before non-IPFS fetch in `resolveMetadata` |
| `src/api/routes/collections.ts` | Add `select` to `?include=profile` query to exclude `gatedContentUrl` |

---

## Task 1: Remove unverified wallet-header path from `identityAuth`

**Files:**
- Modify: `src/api/middleware/identityAuth.ts`

- [ ] **Step 1: Read the current middleware to confirm the exact lines**

  Open `src/api/middleware/identityAuth.ts`. Confirm lines 46–57 contain Path 2 (`x-wallet-address` header, no cryptographic check).

- [ ] **Step 2: Delete Path 2 — the unverified header block**

  Replace the full content of `src/api/middleware/identityAuth.ts` with:

  ```typescript
  import { createClerkClient, verifyToken } from "@clerk/backend";
  import type { Context, Next } from "hono";
  import { normalizeAddress } from "../../utils/starknet.js";

  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY!,
  });

  /**
   * Resolves caller identity to a walletAddress from a verified Clerk JWT.
   *
   * Path 1 — Clerk JWT  (Authorization: Bearer <token>)
   *   Validates JWT, fetches wallet from Clerk metadata.
   *   Sets walletAddress + clerkUserId.
   *
   * Path 2 (future) — SIWS signature
   *   Reserved for stateless Starknet signature verification.
   */
  export async function identityAuth(c: Context, next: Next) {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY!,
        });
        const user = await clerk.users.getUser(payload.sub);
        const rawWallet = (user.publicMetadata?.publicKey ?? user.publicMetadata?.walletAddress) as string | undefined;
        if (!rawWallet) {
          return c.json({ error: "No wallet associated with this account" }, 403);
        }
        c.set("walletAddress", normalizeAddress(rawWallet));
        c.set("clerkUserId", payload.sub);
      } catch {
        return c.json({ error: "Invalid or expired session token" }, 401);
      }
      return next();
    }

    // Path 2: SIWS signature (future)
    // Reserved for stateless Starknet signature verification.

    return c.json({ error: "Authentication required" }, 401);
  }

  /**
   * Strict variant: only accepts Clerk JWT in Authorization: Bearer.
   * Alias for identityAuth — kept for call-site clarity and future divergence.
   */
  export async function requireClerkJwt(c: Context, next: Next) {
    return identityAuth(c, next);
  }
  ```

- [ ] **Step 3: Start the dev server and confirm it compiles**

  ```bash
  ~/.bun/bin/bun run dev
  ```

  Expected: server starts on port 3000 with no TypeScript errors. If there are import errors in route files that still use `identityAuth`, fix them in subsequent tasks — but the middleware file itself must compile cleanly.

- [ ] **Step 4: Verify a write endpoint now requires Clerk JWT**

  ```bash
  curl -s -X PATCH http://localhost:3000/v1/creators/0x1234/profile \
    -H "x-api-key: <any valid tenant key>" \
    -H "x-wallet-address: 0x1234" \
    -H "Content-Type: application/json" \
    -d '{"displayName":"test"}' | jq .
  ```

  Expected: `{"error":"Authentication required"}` with HTTP 401. If you get `{"error":"Clerk session token required"}` that is also acceptable.

- [ ] **Step 5: Commit**

  ```bash
  git add src/api/middleware/identityAuth.ts
  git commit -m "security: remove unverified x-wallet-address path from identityAuth"
  ```

---

## Task 2: Audit and harden all routes that used the removed Path 2

**Files:**
- Modify: `src/api/routes/profiles.ts`
- Modify: `src/api/routes/username-claims.ts`
- Modify: `src/api/routes/reports.ts`
- Modify: `src/api/routes/remix-offers.ts`
- Modify: `src/api/routes/users.ts`

The goal of this task is to confirm that every route using `identityAuth` either (a) already uses `requireClerkJwt` (fine — they're now identical), or (b) was relying on the removed Path 2 and needs explicit confirmation that Clerk JWT is the right auth path.

- [ ] **Step 1: Find all routes using identityAuth**

  ```bash
  grep -rn "identityAuth\|requireClerkJwt" ~/.bun/bin/../.. src/api/routes/ --include="*.ts"
  ```

  Note every file and line. This is your checklist for Step 2.

- [ ] **Step 2: Review each route's auth requirement**

  For each route that calls `identityAuth` directly (not `requireClerkJwt`), read the handler and confirm the operation is a write or identity-sensitive read. If so, change `identityAuth` to `requireClerkJwt` for explicitness — they are now functionally identical, but using `requireClerkJwt` at call sites documents the intent.

  Common pattern to find and update (in each affected route file):
  ```typescript
  // Before:
  import { identityAuth } from "../middleware/identityAuth.js";
  route.post("/", identityAuth, handler);

  // After:
  import { requireClerkJwt } from "../middleware/identityAuth.js";
  route.post("/", requireClerkJwt, handler);
  ```

  For `src/api/routes/profiles.ts` — the collection profile PATCH has a two-path admin-or-user guard that calls `identityAuth(c, next)` directly as a function. This is fine as-is since `identityAuth` and `requireClerkJwt` are now identical.

- [ ] **Step 3: Start dev server and confirm no TypeScript errors**

  ```bash
  ~/.bun/bin/bun run dev
  ```

  Expected: clean compile, server on port 3000.

- [ ] **Step 4: Smoke test an affected endpoint with a Clerk JWT**

  If you have a valid Clerk JWT for a test user, confirm a write endpoint works correctly with it:

  ```bash
  curl -s -X POST http://localhost:3000/v1/reports \
    -H "x-api-key: <tenant key>" \
    -H "Authorization: Bearer <clerk_jwt>" \
    -H "Content-Type: application/json" \
    -d '{"targetType":"TOKEN","targetKey":"TOKEN::0x123::1","reason":"test"}' | jq .
  ```

  Expected: 200/201 or a validation error — not a 401.

- [ ] **Step 5: Commit**

  ```bash
  git add src/api/routes/
  git commit -m "security: replace identityAuth with requireClerkJwt on write routes"
  ```

---

## Task 3: Add SSRF guard to `resolveMetadata` in discovery pipeline

**Files:**
- Modify: `src/discovery/index.ts`

The `isPrivateOrInsecureUrl` utility already exists in `src/utils/ssrf.ts` and is used in the API routes. It just needs to be imported and called in the discovery pipeline before any non-IPFS HTTP fetch.

- [ ] **Step 1: Read the current `resolveMetadata` to confirm the injection point**

  Open `src/discovery/index.ts`. Confirm the `else` branch (lines 35–39) calls `resolveUri(uri)` then `fetchJson(url)` with no SSRF guard. The IPFS branch (lines 24–32) fetches from known IPFS gateways — those are safe and don't need guarding.

- [ ] **Step 2: Add the SSRF guard**

  Replace `src/discovery/index.ts` with:

  ```typescript
  import { getIpfsFallbackUrls, resolveUri } from "./resolver.js";
  import { fetchJson } from "./fetcher.js";
  import { getCachedMetadata, setCachedMetadata } from "./cache.js";
  import { isIpfsUri } from "../utils/ipfs.js";
  import { isPrivateOrInsecureUrl } from "../utils/ssrf.js";
  import { createLogger } from "../utils/logger.js";

  const log = createLogger("discovery");

  /**
   * Resolve a token URI to its metadata JSON.
   * Uses caching and IPFS gateway fallbacks.
   */
  export async function resolveMetadata(
    uri: string
  ): Promise<Record<string, unknown> | null> {
    // Check cache
    const cached = getCachedMetadata(uri);
    if (cached) return cached;

    const isIpfs = isIpfsUri(uri);
    let metadata: Record<string, unknown> | null = null;
    let resolvedUrl: string | null = null;

    if (isIpfs) {
      // Try each gateway in order
      const urls = getIpfsFallbackUrls(uri);
      for (const url of urls) {
        metadata = await fetchJson(url);
        if (metadata) {
          resolvedUrl = url;
          break;
        }
        log.debug({ url }, "IPFS gateway failed, trying next");
      }
    } else {
      const { url } = resolveUri(uri);
      // SSRF guard: block private/internal IPs and non-https schemes.
      // Allow http:// for legacy token URIs (requireHttps=false), but always
      // block RFC-1918, loopback, link-local, and cloud metadata ranges.
      if (isPrivateOrInsecureUrl(url, false)) {
        log.warn({ url }, "Blocked SSRF attempt in token URI");
        setCachedMetadata(uri, null, null, false);
        return null;
      }
      resolvedUrl = url;
      metadata = await fetchJson(url);
    }

    // Cache result (even null, to avoid repeated failed fetches)
    setCachedMetadata(uri, resolvedUrl, metadata, isIpfs);

    return metadata;
  }
  ```

  Note: `requireHttps=false` is intentional — token URIs on-chain may legitimately use `http://` for some older contracts, and the important protection is blocking private IP ranges. The `isPrivateOrInsecureUrl(url, false)` call blocks all RFC-1918 / loopback / link-local / metadata ranges regardless of scheme.

- [ ] **Step 3: Verify it compiles**

  ```bash
  ~/.bun/bin/bun run dev
  ```

  Expected: clean compile.

- [ ] **Step 4: Manual SSRF smoke test**

  If you have a token in the DB with a `tokenUri` you can safely set to an internal address, test that it returns null. Otherwise, verify by reading the log output when the orchestrator processes a `METADATA_FETCH` job — a log line `"Blocked SSRF attempt in token URI"` should appear for any `tokenUri` pointing to a private range.

  You can also do a quick unit check by importing the function in a scratch script:
  ```typescript
  // test-ssrf.ts (delete after)
  import { isPrivateOrInsecureUrl } from "./src/utils/ssrf.js";
  console.log(isPrivateOrInsecureUrl("http://169.254.169.254/latest", false)); // true (blocked)
  console.log(isPrivateOrInsecureUrl("http://10.0.0.1/admin", false));         // true (blocked)
  console.log(isPrivateOrInsecureUrl("https://ipfs.io/ipfs/Qm...", false));    // false (allowed)
  ```

  Run: `~/.bun/bin/bun run test-ssrf.ts`

- [ ] **Step 5: Commit**

  ```bash
  git add src/discovery/index.ts
  git commit -m "security: add SSRF guard to resolveMetadata for on-chain token URIs"
  ```

---

## Task 4: Fix gated content URL leak via `?include=profile`

**Files:**
- Modify: `src/api/routes/collections.ts`

The fix is to strip `gatedContentUrl` and `gatedContentType` from the profile object before returning it, mirroring what the dedicated `GET /v1/collections/:contract/profile` endpoint does.

- [ ] **Step 1: Read the current handler to confirm the leak**

  Open `src/api/routes/collections.ts` and find `GET /:contract` (around line 185). Confirm that `include: { profile: true }` has no `select` clause and the full profile is spread into the response.

- [ ] **Step 2: Strip sensitive fields before response**

  Replace the `GET /:contract` handler body with the following (the route registration line `collections.get("/:contract", async (c) => {` stays the same):

  ```typescript
  collections.get("/:contract", async (c) => {
    const { contract } = c.req.param();
    const include = c.req.query("include");
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress(contract) } },
      ...(include === "profile" ? { include: { profile: true } } : {}),
    });
    if (!col) return c.json({ error: "Collection not found" }, 404);

    let profileData: Record<string, unknown> | null = null;
    if (include === "profile") {
      const profile = (col as any).profile ?? null;
      if (profile) {
        // gatedContentUrl and gatedContentType are only returned to verified
        // token holders via GET /v1/collections/:contract/gated-content
        const { gatedContentUrl: _url, gatedContentType: _type, ...safeProfile } = profile;
        profileData = safeProfile;
      }
    }

    return c.json({
      data: {
        ...serializeCollection(col),
        ...(include === "profile" ? { profile: profileData } : {}),
      },
    });
  });
  ```

- [ ] **Step 3: Verify it compiles and the field is gone**

  Start the server:
  ```bash
  ~/.bun/bin/bun run dev
  ```

  Then test — first set a `gatedContentUrl` on a collection profile (via admin or directly in DB), then query:

  ```bash
  curl -s "http://localhost:3000/v1/collections/<contract>?include=profile" \
    -H "x-api-key: <tenant key>" | jq '.data.profile | keys'
  ```

  Expected: the key list does **not** include `gatedContentUrl` or `gatedContentType`.

  Also confirm the field is still returned by the authenticated endpoint:

  ```bash
  curl -s "http://localhost:3000/v1/collections/<contract>/gated-content" \
    -H "x-api-key: <tenant key>" \
    -H "Authorization: Bearer <clerk_jwt_of_token_holder>" | jq .
  ```

  Expected: `{ title, url, type }` — or 403 if the test wallet doesn't hold a token.

- [ ] **Step 4: Commit**

  ```bash
  git add src/api/routes/collections.ts
  git commit -m "security: exclude gatedContentUrl from ?include=profile response"
  ```

---

## Verification Checklist

After all four tasks are committed, run this final check:

- [ ] **Auth bypass**: `curl -X PATCH /v1/creators/0xANY/profile -H "x-wallet-address: 0xANY"` returns 401 (no JWT)
- [ ] **SSRF**: Server log shows no panics or unexpected fetches; orchestrator handles METADATA_FETCH jobs normally for real IPFS/HTTPS URIs
- [ ] **Data leak**: `GET /v1/collections/:contract?include=profile` response does not contain `gatedContentUrl`
- [ ] Server starts cleanly with `~/.bun/bin/bun run dev`
- [ ] No TypeScript compile errors
