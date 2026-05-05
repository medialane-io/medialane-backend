# SIWS (Sign-In With Starknet) Design

**Date:** 2026-05-05
**Status:** Approved

---

## Goal

Replace the unverified `x-wallet-address` header in `identityAuth` with a cryptographically verified SIWS flow. Wallet users (medialane-dapp, medialane-portal, AI agents) prove ownership of their Starknet wallet by signing a typed message. The server issues a short-lived token. All subsequent requests use `Authorization: Bearer siws_<token>` — no changes to any route handler.

medialane-io (Clerk path) is **not affected**. Path 1 of `identityAuth` is untouched.

---

## Non-goals

- No SIWS support for admin routes (`/admin/*`) — API_SECRET_KEY only
- No multi-chain support — Starknet mainnet only
- No token refresh endpoint — clients re-authenticate when token expires
- No revocation — testing users only, acceptable tradeoff for simplicity
- `/v1/auth/siws/*` endpoints are public (no tenant API key required) — authentication precedes key issuance for wallet-native clients

---

## Auth Flow

```
1. Client  →  POST /v1/auth/siws/nonce  { walletAddress }
             Server creates SiwsNonce row (5min TTL), returns typed data to sign

2. Client signs the typed data with their Starknet wallet (browser extension, Cartridge, programmatic key)

3. Client  →  POST /v1/auth/siws/verify  { walletAddress, nonce, signature: [r, s] }
             Server looks up nonce, verifies SNIP-12 sig via starknet.js account.verifyMessage()
             Deletes nonce (single-use), returns { token: "siws_<hmac_signed_payload>" }

4. Client sends  Authorization: Bearer siws_<token>  on all subsequent requests
             identityAuth detects siws_ prefix, verifies HMAC locally (no DB, no RPC), sets walletAddress
```

---

## Components

### 1. Database — `SiwsNonce` model

```prisma
model SiwsNonce {
  id            String   @id @default(cuid())
  walletAddress String
  nonce         String   @unique
  expiresAt     DateTime
  createdAt     DateTime @default(now())

  @@index([walletAddress])
}
```

Nonces expire in 5 minutes. Deleted on use (single-use). A cron or startup sweep can purge expired rows, but expiry check on read is sufficient for correctness.

### 2. Route — `POST /v1/auth/siws/nonce`

- **Auth:** None (public)
- **Body:** `{ walletAddress: string }`
- **Action:** Normalizes wallet address, generates a 32-byte random hex nonce, stores `SiwsNonce` row, returns the SNIP-12 typed data object the client must sign
- **Response:**
  ```json
  {
    "nonce": "0xabc123...",
    "typedData": {
      "domain": { "name": "Medialane", "version": "1", "chainId": "SN_MAIN", "revision": "1" },
      "primaryType": "SiwsMessage",
      "types": {
        "StarknetDomain": [
          { "name": "name",     "type": "shortstring" },
          { "name": "version",  "type": "shortstring" },
          { "name": "chainId",  "type": "shortstring" },
          { "name": "revision", "type": "shortstring" }
        ],
        "SiwsMessage": [
          { "name": "wallet", "type": "ContractAddress" },
          { "name": "nonce",  "type": "shortstring" },
          { "name": "app",    "type": "shortstring" }
        ]
      },
      "message": {
        "wallet": "0x<normalizedWallet>",
        "nonce":  "0xabc123...",
        "app":    "medialane.io"
      }
    }
  }
  ```

The `app` field binds the signature to Medialane — prevents replay attacks from signatures intended for other dapps.

### 3. Route — `POST /v1/auth/siws/verify`

- **Auth:** None (public)
- **Body:** `{ walletAddress: string, nonce: string, signature: [string, string] }`
- **Action:**
  1. Normalize wallet address
  2. Look up `SiwsNonce` by nonce — return 400 if not found or expired
  3. Verify `record.walletAddress === normalizedWallet` — return 400 if mismatch
  4. Reconstruct the same `typedData` object from the stored nonce + wallet
  5. Call `account.verifyMessage(typedData, signature)` via `callRpc` (same pattern as `claims.ts:203`)
  6. Delete the nonce row (single-use)
  7. Issue and return a SIWS token
- **Response:** `{ token: "siws_<payload>" }`
- **Errors:** `400 { error: "nonce_expired" }`, `400 { error: "wallet_mismatch" }`, `401 { error: "invalid_signature" }`

### 4. Token format

Self-contained HMAC-SHA256 token. No external JWT library — uses Node's built-in `crypto`.

```
siws_<base64url(payload)>.<hex(hmac)>

payload: { sub: "0x<wallet>", iat: <unix>, exp: <unix + 86400> }
```

Signing key: `SIWS_SECRET` env var (min 32 chars). Separate from `API_SECRET_KEY` so they can rotate independently.

Verification in `identityAuth`:
1. Detect `siws_` prefix
2. Split on `.`, decode payload, verify HMAC
3. Check `exp > now()`
4. Set `walletAddress = payload.sub`

No DB lookup. No RPC call. ~0.1ms verification.

### 5. `identityAuth` — updated Path 2

```
Authorization: Bearer eyJhbGc...   →  Clerk JWT (unchanged Path 1)
Authorization: Bearer siws_...     →  SIWS token (new Path 2, local HMAC verify)
x-wallet-address: 0x...            →  removed
```

The `x-wallet-address` header is removed from `identityAuth` and from the CORS `allowHeaders` list once SIWS is live.

---

## New Files

| File | Purpose |
|---|---|
| `src/api/routes/siws.ts` | Two endpoints: `/nonce` and `/verify` |
| `src/utils/siwsToken.ts` | `issueToken(wallet)` and `verifyToken(raw)` — pure functions, no side effects |

## Modified Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `SiwsNonce` model |
| `src/api/middleware/identityAuth.ts` | Add `siws_` token path; remove `x-wallet-address` path |
| `src/api/middleware/cors.ts` | Remove `x-wallet-address` from `allowHeaders` |
| `src/config/env.ts` | Add `SIWS_SECRET` required env var |
| `src/index.ts` or router | Mount `siws` router at `/v1/auth/siws` |

---

## Environment Variables

| Variable | Notes |
|---|---|
| `SIWS_SECRET` | Min 32 chars. Used to sign/verify SIWS tokens. Add to Railway. |

---

## Security Properties

| Threat | Mitigation |
|---|---|
| Wallet impersonation | SNIP-12 signature required — only the wallet's private key can produce it |
| Nonce replay | Nonces are single-use, deleted on verify |
| Token replay across apps | `app: "medialane.io"` field in typed data |
| Stale nonces | 5-minute TTL checked on read |
| Token forgery | HMAC-SHA256 with server secret |
| Token theft | 24h expiry limits window |
| Clerk path disruption | `siws_` prefix check is additive — Clerk tokens never start with `siws_` |

---

## Compatibility

- **medialane-io (Clerk):** Zero impact. Path 1 is unchanged. Clerk tokens (`eyJhbGc...`) never match the `siws_` prefix.
- **medialane-dapp / medialane-portal:** Update to use the two-step SIWS flow instead of sending `x-wallet-address`.
- **AI agents:** Same two-step flow, fully automatable. Cache the token, re-authenticate on 401.
- **`requireClerkJwt`:** Remains unchanged — still enforces Clerk-only on sensitive endpoints (gated content, etc.).
