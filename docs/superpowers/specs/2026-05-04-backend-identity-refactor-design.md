# Backend Identity Refactor Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clerk-as-identity with wallet-address-as-identity in the backend — middleware renamed, context variables cleaned up, `User` and `Report` models migrated — without breaking any existing caller.

**Architecture:** A single `identityAuth` middleware resolves any supported auth method to a `walletAddress` context variable. Route handlers never see which auth method was used. `clerkUserId` remains available as an optional context field only on the Clerk JWT path (needed for nothing after this refactor — it stays as a no-op for future use). The `User` model uses `walletAddress` as its primary key. The `Report` model deduplicates by `reporterWallet` instead of `reporterUserId`. medialane.io is completely unaffected — Clerk JWT continues to work exactly as before.

**Tech Stack:** Hono, Prisma, TypeScript, PostgreSQL, `@clerk/backend`

---

## Section 1: Middleware & Context

### File changes
- Rename: `src/api/middleware/clerkAuth.ts` → `src/api/middleware/identityAuth.ts`
- Modify: `src/types/hono.ts`
- Modify: `src/api/routes/users.ts`, `profiles.ts`, `remix-offers.ts`, `claims.ts`, `username-claims.ts`, `reports.ts`, `drop.ts`

### Middleware

`identityAuth.ts` keeps the same three-path logic as `clerkAuth.ts`:

- **Path 1 — Clerk JWT** (`Authorization: Bearer <token>`): unchanged. Validates JWT via `@clerk/backend`, extracts wallet from `publicMetadata.publicKey` or `.walletAddress`, sets `c.set("walletAddress", ...)` and `c.set("clerkUserId", ...)`.
- **Path 2 — Wallet-address header** (`x-wallet-address`): unchanged. Trusted via upstream API key validation. Sets `c.set("walletAddress", ...)`. `clerkUserId` not set.
- **Path 3 slot** — commented placeholder for future stateless SIWS signature verification. No implementation in this refactor.
- **No credentials** → `401`.

Exported functions:
- `identityAuth(c, next)` — accepts Path 1 or Path 2
- `requireClerkJwt(c, next)` — strict Path 1 only (replaces `clerkJwtOnly`)

### Context types (`src/types/hono.ts`)

```typescript
export type AppVariables = {
  requestId: string;
  tenant: Tenant;
  apiKey: ApiKey & { tenant: Tenant };
  walletAddress?: string;  // normalized 64-char address — set by identityAuth
  clerkUserId?: string;    // Clerk sub claim — set only on Clerk JWT path
  isAdmin?: boolean;
};
```

### Route handler updates

Every route file that imported `clerkAuth` / `clerkJwtOnly`:
- Import: `clerkAuth` → `identityAuth`, `clerkJwtOnly` → `requireClerkJwt`
- Context reads: `c.get("clerkWallet")` → `c.get("walletAddress")`
- `requireClerkJwt` used only in `reports.ts` and `drop.ts` where it was previously `clerkJwtOnly`

---

## Section 2: User Model

### Prisma schema change

```prisma
// Before
model User {
  id            String   @id @default(cuid())
  clerkUserId   String   @unique
  walletAddress String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([clerkUserId])
}

// After
model User {
  walletAddress String   @id
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

`walletAddress` becomes the primary key. `clerkUserId` and the surrogate `id` are dropped.

### Migration

No data migration needed — no existing users in production (clean slate architecture).

Prisma migration command:
```bash
npx prisma migrate dev --name identity-wallet-pk
```

### Route changes (`src/api/routes/users.ts`)

- `POST /v1/users/me`: `prisma.user.upsert({ where: { clerkUserId } })` → `prisma.user.upsert({ where: { walletAddress } })`. Remove `clerkUserId` read from context.
- `GET /v1/users/me`: `prisma.user.findUnique({ where: { clerkUserId } })` → `prisma.user.findUnique({ where: { walletAddress } })`. Remove `clerkUserId` read from context.

---

## Section 3: Report Model

### Prisma schema change

```prisma
// Before
model Report {
  ...
  reporterUserId String           // Clerk user ID
  @@unique([targetKey, reporterUserId])
}

// After
model Report {
  ...
  reporterWallet String           // wallet address
  @@unique([targetKey, reporterWallet])
}
```

### Migration

No data migration needed (clean slate).

```bash
npx prisma migrate dev --name report-reporter-wallet
```

### Route changes (`src/api/routes/reports.ts`)

- `clerkJwtOnly` guard → `identityAuth` (wallet-header callers can now submit reports)
- `c.get("clerkUserId")` → `c.get("walletAddress")`
- `reporterUserId` → `reporterWallet` in all Prisma calls (`create`, `findUnique`, `@@unique` key)

---

## Non-Goals

- No SIWS verification added to the backend in this refactor.
- No changes to medialane.io — Clerk JWT path is preserved exactly.
- No changes to the tenant/API key system.
- No changes to any other route files beyond the import and context-read renames.
