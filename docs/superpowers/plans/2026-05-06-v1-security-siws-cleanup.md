# v1 Security & Auth Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close broken auth paths in medialane-dapp (x-wallet-address → SIWS), fix SDK silent error swallowing, and run security audits on all three frontend repos before v1.

**Architecture:** Four sequential workstreams executed in this order — (1) SDK error handling fix (isolated, no auth complexity); (2) Dapp SIWS wire-up (new hook + three file patches); (3) Security audits of dapp, portal, and medialane-io; (4) Patch any HIGH/MEDIUM findings from audits. The SDK fix comes first so later dapp work benefits from correct SDK errors.

**Tech Stack:** TypeScript, Next.js 14 App Router, starknet-react (`@starknet-react/core`), starknet.js, SWR, SIWS (HMAC-signed bearer token issued by medialane-backend `/v1/auth/siws/*`).

---

## Workstream A — medialane-sdk: Fix direct fetch() error handling

**Repo:** `~/dev/medialane-sdk`

### Task 1: Add `checkResponse` helper and fix all 12 direct fetch() calls

**Files:**
- Modify: `src/api/client.ts`

Context: The private `request()` method already throws `MedialaneApiError` on non-ok responses. Twelve methods bypass it and call `fetch()` + `res.json()` directly with no ok check. They silently return error bodies (`{ error: "..." }`) typed as the expected return type. This task adds a private helper and patches all 12 callsites consistently.

- [ ] **Step 1: Add `checkResponse` private helper after the `del` method (~line 127)**

Open `src/api/client.ts` and insert this method after `private del<T>`:

```typescript
  /**
   * Shared ok-check for methods that call fetch() directly (not via request()).
   * allow404: return null instead of throwing on 404.
   * allow403: return null instead of throwing on 403.
   */
  private async checkResponse<T>(
    res: Response,
    options?: { allow404?: boolean; allow403?: boolean }
  ): Promise<T> {
    if (options?.allow404 && res.status === 404) return null as T;
    if (options?.allow403 && res.status === 403) return null as T;
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let message = text;
      try {
        const body = JSON.parse(text) as { error?: string };
        if (body.error) message = body.error;
      } catch { /* use raw text */ }
      throw new MedialaneApiError(res.status, message);
    }
    return res.json() as Promise<T>;
  }
```

- [ ] **Step 2: Fix `claimCollection` (~line 416)**

Replace:
```typescript
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify({ contractAddress, walletAddress }),
    });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify({ contractAddress, walletAddress }),
    });
    return this.checkResponse(res);
```

- [ ] **Step 3: Fix `getCollectionProfile` (~line 447)**

Replace:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    if (res.status === 404) return null;
    return res.json();
```
With:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    return this.checkResponse<ApiCollectionProfile>(res, { allow404: true });
```

- [ ] **Step 4: Fix `updateCollectionProfile` (~line 461)**

Replace:
```typescript
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify(data),
    });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify(data),
    });
    return this.checkResponse<ApiCollectionProfile>(res);
```

- [ ] **Step 5: Fix `getGatedContent` (~line 478)**

Replace:
```typescript
    const res = await fetch(url, {
      headers: { ...this.baseHeaders, "Authorization": `Bearer ${clerkToken}` },
    });
    if (res.status === 403 || res.status === 404) return null;
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      headers: { ...this.baseHeaders, "Authorization": `Bearer ${clerkToken}` },
    });
    return this.checkResponse<{ title: string; url: string; type: string }>(res, { allow404: true, allow403: true });
```

- [ ] **Step 6: Fix `getCreators` (~line 494)**

Replace:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    return this.checkResponse<ApiCreatorListResult>(res);
```

- [ ] **Step 7: Fix `getCreatorProfile` (~line 500)**

Replace:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    if (res.status === 404) return null;
    return res.json();
```
With:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    return this.checkResponse<ApiCreatorProfile>(res, { allow404: true });
```

- [ ] **Step 8: Fix `getCreatorByUsername` (~line 508)**

Replace:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    if (res.status === 404) return null;
    return res.json();
```
With:
```typescript
    const res = await fetch(url, { headers: this.baseHeaders });
    return this.checkResponse<ApiCreatorProfile>(res, { allow404: true });
```

- [ ] **Step 9: Fix `updateCreatorProfile` (~line 522)**

Replace:
```typescript
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify(data),
    });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "x-api-key": this.baseHeaders["x-api-key"] ?? "",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
      body: JSON.stringify(data),
    });
    return this.checkResponse<ApiCreatorProfile>(res);
```

- [ ] **Step 10: Fix `upsertMyWallet` (~line 543)**

Replace:
```typescript
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
    });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clerkToken}`,
      },
    });
    return this.checkResponse<ApiUserWallet>(res);
```

- [ ] **Step 11: Fix `getMyWallet` (~line 560)**

Replace:
```typescript
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${clerkToken}` },
    });
    if (res.status === 404) return null;
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${clerkToken}` },
    });
    return this.checkResponse<ApiUserWallet>(res, { allow404: true });
```

- [ ] **Step 12: Fix `getRemixOffers` (~line 641)**

Replace:
```typescript
    const res = await fetch(url, {
      headers: { ...this.baseHeaders, "Authorization": `Bearer ${clerkToken}` },
    });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, {
      headers: { ...this.baseHeaders, "Authorization": `Bearer ${clerkToken}` },
    });
    return this.checkResponse<ApiResponse<ApiRemixOffer[]>>(res);
```

- [ ] **Step 13: Fix `getRemixOffer` (~line 654)**

Replace:
```typescript
    const res = await fetch(url, { headers });
    return res.json();
```
With:
```typescript
    const res = await fetch(url, { headers });
    return this.checkResponse<ApiResponse<ApiRemixOffer>>(res);
```

- [ ] **Step 14: Verify TypeScript compiles**

```bash
cd ~/dev/medialane-sdk
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
cd ~/dev/medialane-sdk
git add src/api/client.ts
git commit -m "fix: add checkResponse helper — all direct fetch() calls now throw MedialaneApiError on non-ok"
```

---

## Workstream B — medialane-dapp: SIWS wire-up

**Repo:** `~/dev/medialane-dapp`

Context: The backend removed support for the `x-wallet-address` header (it was an impersonation vulnerability). Routes that need wallet identity (`/v1/remix-offers`, `/v1/username-claims`, `/v1/reports`) now require `Authorization: Bearer siws_<token>`. The SIWS flow: dapp calls `POST /v1/auth/siws/nonce` (no API key needed), user signs the returned typed data with their wallet, dapp calls `POST /v1/auth/siws/verify` → receives a 24h HMAC-signed `siws_` bearer token. Token is stored in `localStorage` keyed by wallet address.

### Task 2: Create `useSiwsToken` hook

**Files:**
- Create: `src/hooks/use-siws-token.ts`

- [ ] **Step 1: Create the file**

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "@starknet-react/core";
import { MEDIALANE_BACKEND_URL } from "@/lib/constants";

const STORAGE_PREFIX = "ml_siws_";

function decodeBase64url(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(base64 + padding);
}

function getStoredToken(address: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${address}`);
    if (!raw || !raw.startsWith("siws_")) return null;
    const inner = raw.slice(5);
    const dot = inner.lastIndexOf(".");
    if (dot === -1) return null;
    const data = JSON.parse(decodeBase64url(inner.slice(0, dot))) as { exp?: number };
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) {
      localStorage.removeItem(`${STORAGE_PREFIX}${address}`);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function storeToken(address: string, token: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(`${STORAGE_PREFIX}${address}`, token);
  }
}

export function useSiwsToken() {
  const { account, address } = useAccount();
  const [token, setToken] = useState<string | null>(null);

  // Sync stored token on address change (handles wallet switch / disconnect)
  useEffect(() => {
    if (!address) {
      setToken(null);
      return;
    }
    setToken(getStoredToken(address));
  }, [address]);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!address || !account) return null;
    try {
      // Step 1: Get nonce + SNIP-12 typed data from backend (no API key needed)
      const nonceRes = await fetch(`${MEDIALANE_BACKEND_URL}/v1/auth/siws/nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      if (!nonceRes.ok) return null;
      const { nonce, typedData } = await nonceRes.json() as {
        nonce: string;
        typedData: Parameters<typeof account.signMessage>[0];
      };

      // Step 2: Prompt wallet to sign — user will see the typed data popup
      const signature = await account.signMessage(typedData);

      // Normalise to [r, s] string tuple — starknet.js returns string[] for standard accounts
      const sig: [string, string] = Array.isArray(signature)
        ? [String(signature[0]), String(signature[1])]
        : [String((signature as { r: bigint }).r), String((signature as { s: bigint }).s)];

      // Step 3: Backend verifies the signature and issues a 24h siws_ token
      const verifyRes = await fetch(`${MEDIALANE_BACKEND_URL}/v1/auth/siws/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, nonce, signature: sig }),
      });
      if (!verifyRes.ok) return null;
      const { token: newToken } = await verifyRes.json() as { token: string };

      storeToken(address, newToken);
      setToken(newToken);
      return newToken;
    } catch {
      return null;
    }
  }, [address, account]);

  /**
   * Returns an existing valid token or triggers the SIWS sign-in flow.
   * Call this inside SWR fetchers or mutation handlers, not at render time.
   */
  const getValidToken = useCallback(async (): Promise<string | null> => {
    if (!address) return null;
    const existing = getStoredToken(address);
    if (existing) {
      setToken(existing);
      return existing;
    }
    return signIn();
  }, [address, signIn]);

  return { token, signIn, getValidToken };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/dev/medialane-dapp
npx tsc --noEmit 2>&1 | grep "use-siws-token"
```
Expected: no errors on that file.

- [ ] **Step 3: Commit**

```bash
cd ~/dev/medialane-dapp
git add src/hooks/use-siws-token.ts
git commit -m "feat: add useSiwsToken hook — SIWS nonce/sign/verify flow with localStorage cache"
```

---

### Task 3: Update `use-remix-offers.ts` — replace x-wallet-address with SIWS bearer

**Files:**
- Modify: `src/hooks/use-remix-offers.ts`

- [ ] **Step 1: Add `useSiwsToken` import and replace `apiFetch` auth header**

Replace the entire file content with:

```typescript
"use client";

import useSWR from "swr";
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { useSiwsToken } from "@/hooks/use-siws-token";
import { MEDIALANE_BACKEND_URL, MEDIALANE_API_KEY } from "@/lib/constants";
import type { RemixOffer, RemixOfferListResponse, PublicRemix } from "@/types/remix-offers";

async function apiFetch(
  url: string,
  apiKey: string,
  siwsToken: string | null,
  options?: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (siwsToken) headers["Authorization"] = `Bearer ${siwsToken}`;
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export function useRemixOffers(role: "creator" | "requester", status?: string) {
  const { address: walletAddress } = useUnifiedWallet();
  const { getValidToken } = useSiwsToken();

  const key = walletAddress ? `remix-offers-${role}-${status ?? "all"}-${walletAddress}` : null;

  const { data, error, isLoading, mutate } = useSWR<RemixOfferListResponse>(
    key,
    async () => {
      const token = await getValidToken();
      const params = new URLSearchParams({ role, ...(status ? { status } : {}) });
      return apiFetch(
        `${MEDIALANE_BACKEND_URL}/v1/remix-offers?${params}`,
        MEDIALANE_API_KEY,
        token,
      ) as Promise<RemixOfferListResponse>;
    },
    {
      refreshInterval: 30000,
      revalidateOnFocus: false,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 2) return;
        setTimeout(() => revalidate({ retryCount }), 5000);
      },
    }
  );

  return { offers: data?.data ?? [], total: data?.meta.total ?? 0, isLoading, error, mutate };
}

export function useTokenRemixes(contract: string | null, tokenId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<{ data: PublicRemix[]; meta: { total: number } }>(
    contract && tokenId ? `token-remixes-${contract}-${tokenId}` : null,
    () =>
      fetch(`${MEDIALANE_BACKEND_URL}/v1/tokens/${contract}/${tokenId}/remixes`, {
        headers: { "x-api-key": MEDIALANE_API_KEY },
      }).then((r) => r.json()),
    { refreshInterval: 60000, revalidateOnFocus: false }
  );

  return { remixes: data?.data ?? [], total: data?.meta.total ?? 0, isLoading, error, mutate };
}

async function authedFetch(url: string, token: string | null, options?: RequestInit): Promise<unknown> {
  return apiFetch(url, MEDIALANE_API_KEY, token, options);
}

export async function submitRemixOffer(
  body: {
    originalContract: string;
    originalTokenId: string;
    proposedPrice: string;
    proposedCurrency: string;
    licenseType: string;
    commercial: boolean;
    derivatives: boolean;
    royaltyPct?: number;
    message?: string;
    expiresInDays?: number;
  },
  siwsToken: string | null
): Promise<RemixOffer> {
  const res = await authedFetch(`${MEDIALANE_BACKEND_URL}/v1/remix-offers`, siwsToken, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (res as { data: RemixOffer }).data;
}

export async function submitAutoRemixOffer(
  body: { originalContract: string; originalTokenId: string },
  siwsToken: string | null
): Promise<RemixOffer> {
  const res = await authedFetch(`${MEDIALANE_BACKEND_URL}/v1/remix-offers/auto`, siwsToken, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (res as { data: RemixOffer }).data;
}

export async function confirmSelfRemix(
  body: {
    originalContract: string;
    originalTokenId: string;
    remixContract: string;
    remixTokenId: string;
    txHash: string;
    licenseType: string;
    commercial: boolean;
    derivatives: boolean;
    royaltyPct?: number;
  },
  siwsToken: string | null
): Promise<RemixOffer> {
  const res = await authedFetch(`${MEDIALANE_BACKEND_URL}/v1/remix-offers/self/confirm`, siwsToken, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (res as { data: RemixOffer }).data;
}

export async function confirmRemixOffer(
  id: string,
  body: { remixContract: string; remixTokenId: string; approvedCollection: string; orderHash: string },
  siwsToken: string | null
): Promise<RemixOffer> {
  const res = await authedFetch(`${MEDIALANE_BACKEND_URL}/v1/remix-offers/${id}/confirm`, siwsToken, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (res as { data: RemixOffer }).data;
}

export async function rejectRemixOffer(id: string, siwsToken: string | null): Promise<RemixOffer> {
  const res = await authedFetch(`${MEDIALANE_BACKEND_URL}/v1/remix-offers/${id}/reject`, siwsToken, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return (res as { data: RemixOffer }).data;
}
```

- [ ] **Step 2: Fix any call sites that passed `walletAddress` as the last arg**

Find all callers of `submitRemixOffer`, `submitAutoRemixOffer`, `confirmSelfRemix`, `confirmRemixOffer`, `rejectRemixOffer`:

```bash
grep -rn "submitRemixOffer\|submitAutoRemixOffer\|confirmSelfRemix\|confirmRemixOffer\|rejectRemixOffer" \
  ~/dev/medialane-dapp/src --include="*.tsx" --include="*.ts" | grep -v "use-remix-offers"
```

For each callsite, replace the last `walletAddress` argument with the SIWS token. The caller component needs to call `useSiwsToken()` to get `getValidToken` and pass `await getValidToken()` as the last argument. Example pattern in a caller component:

```typescript
// Before
const { address } = useUnifiedWallet();
await submitRemixOffer(body, address);

// After
const { getValidToken } = useSiwsToken();
const token = await getValidToken();
await submitRemixOffer(body, token);
```

- [ ] **Step 3: TypeScript check**

```bash
cd ~/dev/medialane-dapp
npx tsc --noEmit 2>&1 | grep "remix-offers"
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/medialane-dapp
git add src/hooks/use-remix-offers.ts
git commit -m "fix: replace x-wallet-address with SIWS bearer in use-remix-offers"
```

---

### Task 4: Update `use-username-claims.ts` — replace x-wallet-address with SIWS bearer

**Files:**
- Modify: `src/hooks/use-username-claims.ts`

- [ ] **Step 1: Replace wallet-address auth with SIWS**

Replace the `useMyUsernameClaim` and `submitUsernameClaim` functions:

```typescript
"use client";

import useSWR from "swr";
import { useUnifiedWallet } from "@/hooks/use-unified-wallet";
import { useSiwsToken } from "@/hooks/use-siws-token";
import { type ApiCreatorProfile } from "@medialane/sdk";
import { getMedialaneClient } from "@/lib/medialane-client";
import { MEDIALANE_BACKEND_URL, MEDIALANE_API_KEY } from "@/lib/constants";

export interface UsernameClaim {
  id: string;
  username: string;
  walletAddress: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  adminNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export type { ApiCreatorProfile as CreatorByUsername };

export function useMyUsernameClaim() {
  const { address, isConnected } = useUnifiedWallet();
  const { getValidToken } = useSiwsToken();

  const { data, error, isLoading, mutate } = useSWR(
    isConnected && address ? `username-claim-me-${address}` : null,
    async () => {
      const token = await getValidToken();
      if (!token) throw new Error("Authentication required");
      const res = await fetch(`${MEDIALANE_BACKEND_URL}/v1/username-claims/me`, {
        headers: {
          "x-api-key": MEDIALANE_API_KEY,
          "Authorization": `Bearer ${token}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch username claim");
      return res.json() as Promise<{ username: string | null; claim: UsernameClaim | null }>;
    },
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  return { username: data?.username ?? null, claim: data?.claim ?? null, isLoading, error, mutate };
}

export async function checkUsernameAvailability(
  username: string
): Promise<{ available: boolean; reason?: string }> {
  const res = await fetch(`${MEDIALANE_BACKEND_URL}/v1/username-claims/check/${encodeURIComponent(username)}`, {
    headers: { "x-api-key": MEDIALANE_API_KEY },
  });
  return res.json();
}

export async function submitUsernameClaim(
  username: string,
  siwsToken: string,
  notifyEmail?: string
): Promise<{ claim?: UsernameClaim; error?: string }> {
  const res = await fetch(`${MEDIALANE_BACKEND_URL}/v1/username-claims`, {
    method: "POST",
    headers: {
      "x-api-key": MEDIALANE_API_KEY,
      "Authorization": `Bearer ${siwsToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, ...(notifyEmail ? { notifyEmail } : {}) }),
  });
  const json = await res.json();
  if (!res.ok) return { error: (json as { error?: string }).error ?? "Failed to submit claim" };
  return { claim: (json as { claim: UsernameClaim }).claim };
}

export function useCreatorByUsername(username: string | null | undefined) {
  const { data, error, isLoading } = useSWR(
    username ? `creator-by-username-${username}` : null,
    () => getMedialaneClient().api.getCreatorByUsername(username!),
    { revalidateOnFocus: false, revalidateOnMount: true }
  );
  return { creator: data ?? null, isLoading, error };
}
```

- [ ] **Step 2: Update `submitUsernameClaim` callsite**

Find the caller:

```bash
grep -rn "submitUsernameClaim" ~/dev/medialane-dapp/src --include="*.tsx" --include="*.ts" | grep -v "use-username-claims"
```

In the caller, change the second argument from `walletAddress` to `await getValidToken()`:

```typescript
// Before: submitUsernameClaim(username, walletAddress, notifyEmail)
// After:
const { getValidToken } = useSiwsToken();
const token = await getValidToken();
if (!token) { toast.error("Please connect your wallet"); return; }
await submitUsernameClaim(username, token, notifyEmail);
```

- [ ] **Step 3: TypeScript check**

```bash
cd ~/dev/medialane-dapp
npx tsc --noEmit 2>&1 | grep "username-claims"
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/medialane-dapp
git add src/hooks/use-username-claims.ts
git commit -m "fix: replace x-wallet-address with SIWS bearer in use-username-claims"
```

---

### Task 5: Update report flow — forward SIWS token through API route

**Files:**
- Modify: `src/app/api/reports/route.ts`
- Modify: `src/components/report-dialog.tsx`

Context: `report-dialog.tsx` calls the dapp's own `/api/reports` Next.js route, which proxies to the backend. The backend's `/v1/reports` requires `identityAuth` (wallet auth). The fix: the dialog passes the SIWS token as `X-Siws-Token` to the API route, which forwards it as `Authorization: Bearer`.

- [ ] **Step 1: Update `src/app/api/reports/route.ts` to read and forward the SIWS token**

Replace the entire file:

```typescript
import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_MEDIALANE_BACKEND_URL!;
const API_KEY = process.env.NEXT_PUBLIC_MEDIALANE_API_KEY!;

function normalizeAddress(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + hex.padStart(64, "0");
}

export async function POST(req: NextRequest) {
  // SIWS bearer token — set by report-dialog after sign-in
  const siwsToken = req.headers.get("x-siws-token");
  if (!siwsToken) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: {
    targetType: "TOKEN" | "COLLECTION" | "CREATOR" | "COMMENT";
    targetContract?: string;
    targetTokenId?: string;
    targetAddress?: string;
    targetId?: string;
    categories: string[];
    description?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.targetType || !body.categories?.length) {
    return NextResponse.json(
      { error: "targetType and categories are required" },
      { status: 400 }
    );
  }

  const validTypes = ["TOKEN", "COLLECTION", "CREATOR", "COMMENT"];
  if (!validTypes.includes(body.targetType)) {
    return NextResponse.json({ error: "Invalid targetType" }, { status: 400 });
  }

  const normalizedContract = body.targetContract
    ? normalizeAddress(body.targetContract)
    : undefined;
  const normalizedAddress = body.targetAddress
    ? normalizeAddress(body.targetAddress)
    : undefined;

  let targetKey: string;
  if (body.targetType === "TOKEN" && normalizedContract && body.targetTokenId) {
    targetKey = `TOKEN:${normalizedContract}:${body.targetTokenId}`;
  } else if (body.targetType === "COLLECTION" && normalizedContract) {
    targetKey = `COLLECTION:${normalizedContract}`;
  } else if (body.targetType === "CREATOR" && normalizedAddress) {
    targetKey = `CREATOR:${normalizedAddress}`;
  } else if (body.targetType === "COMMENT" && body.targetId) {
    targetKey = `COMMENT::${body.targetId}`;
  } else {
    return NextResponse.json(
      { error: "Invalid target fields for targetType" },
      { status: 400 }
    );
  }

  const res = await fetch(`${BACKEND_URL}/v1/reports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "Authorization": `Bearer ${siwsToken}`,
    },
    body: JSON.stringify({
      targetType: body.targetType,
      targetKey,
      targetContract: normalizedContract,
      targetTokenId: body.targetTokenId,
      targetAddress: normalizedAddress,
      targetId: body.targetId,
      categories: body.categories,
      description: body.description,
    }),
  });

  if (res.status === 409) {
    return NextResponse.json({ error: "Already reported" }, { status: 409 });
  }
  if (res.status === 429) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "Failed to submit report" }, { status: 500 });
  }

  return NextResponse.json({ success: true }, { status: 201 });
}
```

- [ ] **Step 2: Update `src/components/report-dialog.tsx` to get SIWS token and pass it**

Find the `handleSubmit` function (around line 60–112). At the top of `handleSubmit`, add SIWS token retrieval. The component needs to import `useSiwsToken`:

Add import at top of file (with other imports):
```typescript
import { useSiwsToken } from "@/hooks/use-siws-token";
```

Add hook call inside the component (near other hook calls at the top of the function body):
```typescript
const { getValidToken } = useSiwsToken();
```

Update `handleSubmit` to get the token before calling `/api/reports`:
```typescript
  const handleSubmit = async () => {
    setLoading(true);

    const siwsToken = await getValidToken();
    if (!siwsToken) {
      toast.error("Please connect your wallet to submit a report");
      setLoading(false);
      return;
    }

    // ... existing payload construction ...

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-siws-token": siwsToken,
        },
        body: JSON.stringify(payload),
      });
      // ... rest of existing error handling unchanged ...
```

- [ ] **Step 3: TypeScript check**

```bash
cd ~/dev/medialane-dapp
npx tsc --noEmit 2>&1 | grep -E "report|siws"
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/dev/medialane-dapp
git add src/app/api/reports/route.ts src/components/report-dialog.tsx
git commit -m "fix: forward SIWS bearer token through reports API route to backend identityAuth"
```

---

## Workstream C — Security Audits

### Task 6: Security audit — medialane-dapp

**Repo:** `~/dev/medialane-dapp`

- [ ] **Step 1: Run the security-review skill on medialane-dapp**

From within the medialane-dapp repo, invoke:
```
/security-review
```

Scope the audit on the full codebase (no diff — this is a fresh audit). Specifically prioritise:
- `src/app/api/*` routes — SSRF, path traversal, missing auth
- `src/app/api/ipfs/[...cid]/route.ts` — CID validation (already has regex, verify it's tight)
- `src/app/api/pinata/*` — secrets in client bundles, unvalidated uploads
- Any `dangerouslySetInnerHTML` usage
- `NEXT_PUBLIC_*` env vars — confirm no private secrets are prefixed with NEXT_PUBLIC_

- [ ] **Step 2: For each HIGH/MEDIUM finding with confidence ≥ 8, implement the fix**

Apply fixes, then:
```bash
cd ~/dev/medialane-dapp
npx tsc --noEmit
git add -p
git commit -m "fix(security): <finding summary>"
```

- [ ] **Step 3: Push**

```bash
cd ~/dev/medialane-dapp
git push origin main
```

---

### Task 7: Security audit — medialane-portal

**Repo:** `~/dev/medialane-portal`

- [ ] **Step 1: Run the security-review skill on medialane-portal**

From within the medialane-portal repo, invoke:
```
/security-review
```

Prioritise:
- `src/lib/siws.ts` — nonce generation entropy, timing-safe comparison in signature verify
- `src/lib/session.ts` — JWT secret length, cookie flags (HttpOnly, Secure, SameSite)
- `src/app/api/auth/verify/route.ts` — signature array bounds check (already present, confirm tight)
- `src/app/api/portal/[...path]/route.ts` — path traversal guard (already present, confirm)
- `src/app/api/proxy/route.ts` — hostname allowlist (already present, confirm no bypass)
- `src/lib/db.ts` — SQL injection in any raw queries
- Any `console.log` of session tokens or private keys

- [ ] **Step 2: For each HIGH/MEDIUM finding with confidence ≥ 8, implement the fix**

```bash
cd ~/dev/medialane-portal
npx tsc --noEmit
git add -p
git commit -m "fix(security): <finding summary>"
git push origin main
```

---

### Task 8: Security audit — medialane-io

**Repo:** `~/dev/medialane-io`

- [ ] **Step 1: Run the security-review skill on medialane-io**

From within the medialane-io repo, invoke:
```
/security-review
```

Prioritise:
- `src/app/api/admin/[...path]/route.ts` — confirm `API_SECRET_KEY` check is present; verify no path traversal to non-admin routes
- `src/app/api/reports/route.ts` — Clerk JWT validation flow (confirm it uses `auth()` correctly)
- `src/app/api/rpc/route.ts` — if it proxies Starknet RPC calls, check for SSRF or parameter injection
- `src/app/api/pinata/*` — confirm `PINATA_JWT` is not a `NEXT_PUBLIC_` env var
- `src/app/api/ipfs/[...cid]/route.ts` — CID regex (same as dapp, confirm)
- Any Clerk admin-gated routes — confirm `auth()` is called and `userId` is checked

- [ ] **Step 2: For each HIGH/MEDIUM finding with confidence ≥ 8, implement the fix**

```bash
cd ~/dev/medialane-io
npx tsc --noEmit
git add -p
git commit -m "fix(security): <finding summary>"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ✅ SDK fetch() error handling — Task 1
- ✅ Dapp SIWS wire-up — Tasks 2–5 (hook, remix-offers, username-claims, reports)
- ✅ medialane-dapp audit — Task 6
- ✅ medialane-portal audit — Task 7
- ✅ medialane-io audit — Task 8

**Placeholder scan:** No TBD or TODO in implementation steps. Audit tasks (6–8) are open-ended by nature — findings are unknown until the audit runs. Fix steps inside those tasks follow the same pattern as prior audits and are fully actionable.

**Type consistency:** `siwsToken: string | null` used consistently across Tasks 2–5. `getValidToken(): Promise<string | null>` matches the hook definition.
