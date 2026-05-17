# Service-Model Phase 2D — Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy `CollectionSource`/`source` end-to-end — add a backend `?service=` filter, migrate every remaining `?source=`-query frontend site to it, drop the deprecated SDK surface, then drop the `source` dual-write + `CollectionSource` enum/column.

**Architecture:** The final phase of the service-model refactor (`05-service-model.md`; follows `2026-05-16-service-model-refactor.md` which shipped 2A/2B/2C). Four **sequential, independently-shippable sub-phases**, each with a hard ship gate, mirroring the 2A→2C pattern: 2D.1 backend additive `?service=` → 2D.2 frontends migrate → 2D.3 SDK `0.13.0` removes deprecated `source` → 2D.4 backend irreversible drop of dual-write + `CollectionSource`.

**Tech Stack:** Bun + Prisma v5 + PostgreSQL (backend), `@medialane/sdk` (tsup/TS), Next.js (medialane-dapp = npm, medialane-io = bun).

---

## ⚠️ GLOBAL GATE — do not start until the 2C soak is clean

**Precondition for the whole plan:** Phase 2C (dapp + io) has been live in production with **no service-model incidents** for a deliberate soak window, AND psql confirms the auto-backfill (PR #5) populated `service` for all non-external rows:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql "$DATABASE_URL_PROD" -c \
'SELECT COUNT(*) FROM "Collection" WHERE service IS NULL AND source NOT LIKE '"'"'EXTERNAL%'"'"';'
```
Expected: `0`. **If not 0, STOP** — investigate the backfill before any 2D work. 2D.4 is irreversible.

**Verification discipline (per each repo's CLAUDE.md — user instruction overrides skill TDD default):** no test runners exist. Gates are: backend `bun x tsc --noEmit` (differential vs the known 8-error baseline) + `psql` + `curl`; SDK `bun x tsc --noEmit` + `bun run build`; dapp `npx tsc --noEmit` + `npm run build`; io `bun run typecheck` + `bun run build`. Plus grep assertions. These are the project's real gates.

**Canonical id mapping** (used everywhere a legacy source string becomes a service id):
`MEDIALANE_ERC721`/`MEDIALANE_REGISTRY` → `mip-erc721` · `MEDIALANE_ERC1155`/`ERC1155_FACTORY` → `mip-erc1155` · `POP_PROTOCOL` → `pop-protocol` · `COLLECTION_DROP` → `drop-collection` · `EXTERNAL*` → (no service; `service` is `null`).

---

## File Structure

- **Backend** `medialane-backend/src/api/routes/collections.ts` — add `?service=` filter (2D.1); later drop `?source=` handling + serializer `source` (2D.4).
- **Backend** the 19 dual-write sites (`src/mirror/handlers/{popFactory,dropFactory,ip1155Factory,orderCreated1155}.ts`, `src/mirror/index.ts`, `src/orchestrator/collectionMetadata.ts`, `src/api/routes/{collections,admin,claims}.ts`) — drop `source:` in 2D.4.
- **Backend** `prisma/schema.prisma` + a destructive migration — drop `Collection.source` + `enum CollectionSource` (2D.4).
- **SDK** `medialane-sdk/src/types/api.ts` + `src/api/client.ts` + `package.json` — remove `CollectionSource`/`source`, v`0.13.0` (2D.3).
- **dapp** `src/app/collections/collections-page-client.tsx`, `src/hooks/use-pop.ts`, `src/hooks/use-drops.ts`, `src/app/launchpad/drop/my-drops/page.tsx` (+ any other `?source=`/`source:` query site) — migrate to `service` (2D.2).
- **io** `src/app/collections/collections-page-client.tsx`, `src/hooks/{use-collections,use-claims,use-drops,use-pop}.ts`, `src/app/launchpad/{pop/my-events,drop/my-drops,drop/create,nfteditions/create}/page.tsx`, `src/lib/service-registry.ts` (already service-keyed — verify), `src/app/admin/collections/page.tsx` (admin: migrate display/edit to `service`) — migrate to `service` (2D.2).

---

## PHASE 2D.1 — Backend: additive `?service=` filter

Additive only. Ships + soaks alone. Unblocks 2D.2. Fully revertible.

### Task 2D.1.1: Add `service` query handling to `/v1/collections`

**Files:** Modify `medialane-backend/src/api/routes/collections.ts`

- [ ] **Step 1: Read the current source-filter block**

Run: `sed -n '105,170p' src/api/routes/collections.ts`
Confirm the structure: `VALID_COLLECTION_SOURCES` set (~106), `const source = c.req.query("source")` (~119), validation (~128), raw-SQL branch `conditions.push(Prisma.sql\`source = ${source}::"CollectionSource"\`)` (~138), ORM branch `where.source = source` (~169).

- [ ] **Step 2: Add the `service` query param alongside `source`**

After the line `const source    = c.req.query("source");` add:

```ts
  const service   = c.req.query("service");
```

After the raw-SQL line `if (source)    conditions.push(Prisma.sql\`source = ${source}::"CollectionSource"\`);` add:

```ts
    if (service)   conditions.push(Prisma.sql`service = ${service}`);
```

(`service` is a plain `String?` column — **no `::"CollectionSource"` cast**, unlike `source`.)

After the ORM line `if (source)    where.source = source;` add:

```ts
  if (service)   where.service = service;
```

`service` needs **no `VALID_*` allowlist** — it is an open-ended string by design (`05-service-model §I`); an unknown value simply matches nothing.

- [ ] **Step 3: Differential typecheck**

Run: `bun x tsc --noEmit 2>&1 | grep -cE "error TS"`
Expected: `8` (the known pre-existing baseline; 0 new). If >8, diff against baseline and fix new errors only.

- [ ] **Step 4: Verify behavior (local dev DB)**

Run (seed one row then query):
```bash
bun -e 'import p from "./src/db/client.js"; await p.collection.upsert({where:{chain_contractAddress:{chain:"STARKNET",contractAddress:"0xsvc1"}},create:{chain:"STARKNET",contractAddress:"0xsvc1",startBlock:1n,source:"POP_PROTOCOL",service:"pop-protocol"},update:{service:"pop-protocol"}}); console.log("seeded"); await p.$disconnect();'
```
Then with the dev server running: `curl -s "localhost:3000/v1/collections?service=pop-protocol&limit=5" -H "x-api-key: $TEST_KEY" | head -c 300`
Expected: JSON `data` contains the seeded `0xsvc1`. Then `?service=nonexistent` → empty `data`. Cleanup: delete `0xsvc1`.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/2d1-backend-service-filter
git add src/api/routes/collections.ts
git commit -m "feat(api): add ?service= filter to /v1/collections (Phase 2D.1, additive)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push -u origin feat/2d1-backend-service-filter
gh pr create --base main --title "Phase 2D.1: backend ?service= filter (additive)" --body "Additive ?service= query on /v1/collections, mirroring ?source=. No removals. Unblocks 2D.2 frontend migration. Differential tsc clean. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

**2D.1 SHIP GATE:** PR merged + deployed; `curl …?service=pop-protocol` returns rows in prod. Soak briefly. Then 2D.2.

---

## PHASE 2D.2 — Frontends: migrate `?source=` query sites to `?service=`

Depends on 2D.1 deployed. **dapp** and **io** are separate PRs (separate deploys / QA), dapp first.

**Transformation rule (every backend collection query):** replace the `source` query value with the canonical `service` id and the param name `source`→`service`.

| Legacy | New |
|---|---|
| `new URLSearchParams({ source: "POP_PROTOCOL", … })` | `new URLSearchParams({ service: "pop-protocol", … })` |
| `{ source: "COLLECTION_DROP", … }` | `{ service: "drop-collection", … }` |
| `source: "MEDIALANE_ERC1155"` (io editions) | `service: "mip-erc1155"` |
| `?source=COLLECTION_DROP&owner=` (string) | `?service=drop-collection&owner=` |
| filter-tab values `"POP_PROTOCOL"`/`"COLLECTION_DROP"` | `"pop-protocol"`/`"drop-collection"` |
| `useState<CollectionSource>` filter state | `useState<string>` |
| `import type { CollectionSource } from "@medialane/sdk"` (query-only use) | remove (use `string`) |

### Task 2D.2.1: dapp migration

**Files (enumerate authoritatively first):**

- [ ] **Step 1: List every dapp source-query site**

Run: `cd /Users/kalamaha/dev/medialane-dapp && grep -rnE '\?source=|source: "(POP_PROTOCOL|COLLECTION_DROP|MEDIALANE_ERC721|MEDIALANE_ERC1155)"|params\.set\("source"|SOURCE_TABS|useState<CollectionSource' src --include='*.ts' --include='*.tsx'`
Known set: `src/hooks/use-pop.ts` (×2: lines ~25, ~70), `src/hooks/use-drops.ts` (~48), `src/app/launchpad/drop/my-drops/page.tsx` (~20), `src/app/collections/collections-page-client.tsx` (`SOURCE_TABS` ~34, `source` state, the 2C NOTE comment ~25-33). Use the grep output as the authoritative list.

- [ ] **Step 2: Apply the transformation rule per file**

For each: change the query param `source`→`service` and its value via the canonical mapping; in `collections-page-client.tsx` re-key `SOURCE_TABS` values to `pop-protocol`/`drop-collection`, change the `source`/`setSource` state type to `string | undefined`, and **delete the 2C "NOTE (service-model refactor 2C): … Do NOT blind-swap" comment block** (it's now done). Drop any `CollectionSource` import used only for the query.

- [ ] **Step 3: Gate**

Run: `cd /Users/kalamaha/dev/medialane-dapp && npx tsc --noEmit 2>&1 | grep -cE "error TS"` → `0`; then `npm run build` → OK; then `grep -rnE '\?source=|"POP_PROTOCOL"|"COLLECTION_DROP"|CollectionSource' src --include='*.ts' --include='*.tsx'` → no matches.

- [ ] **Step 4: Commit + PR** (`feat/2d2-dapp-service-queries`, base `main`): title "Phase 2D.2 (dapp): migrate ?source= → ?service=", body listing the files + "depends on 2D.1 deployed; tsc 0 + build OK; no source-query remains" + the Claude Code trailer. Salvador QAs on dapp.medialane.io: collections POP/Drop filter, my-drops, pop/drop hooks still return correct results.

### Task 2D.2.2: io migration

**Files (enumerate first):**

- [ ] **Step 1: List every io source-query site**

Run: `cd /Users/kalamaha/dev/medialane-io && grep -rnE '\?source=|params\.set\("source"|source: "(POP_PROTOCOL|COLLECTION_DROP|MEDIALANE_ERC1155)"|SOURCE_TABS|useState<CollectionSource' src --include='*.ts' --include='*.tsx'`
Known files: `src/hooks/{use-collections,use-claims,use-drops,use-pop}.ts`, `src/app/launchpad/{pop/my-events,drop/my-drops,drop/create,nfteditions/create}/page.tsx`, `src/app/collections/collections-page-client.tsx` (`SOURCE_TABS` + 2C NOTE), `src/app/admin/collections/page.tsx` (admin display/edit of the raw field). Use grep output as authoritative.

- [ ] **Step 2: Apply the transformation rule per file** (same table). For `collections-page-client.tsx` re-key `SOURCE_TABS` to service ids, retype `source` state to `string | undefined`, delete the 2C NOTE block. For `admin/collections/page.tsx`: replace the `SOURCE_STYLE` keys + the editable values with service ids (display the `service` field instead of `source`). `src/lib/service-registry.ts` is already service-keyed (Phase 2C) — verify no `CollectionSource` query usage remains.

- [ ] **Step 3: Gate**

Run: `cd /Users/kalamaha/dev/medialane-io && bun run typecheck 2>&1 | grep -cE "error TS"` → `0`; `bun run build` → OK; `grep -rnE '\?source=|"POP_PROTOCOL"|"COLLECTION_DROP"|CollectionSource' src --include='*.ts' --include='*.tsx'` → no matches.

- [ ] **Step 4: Commit + PR** (`feat/2d2-io-service-queries`): analogous body. Salvador QAs on medialane.io: collections filter, launchpad my-events/my-drops/create, admin collections page.

**2D.2 SHIP GATE:** both PRs merged + deployed + Salvador QA confirms filters/launchpad/admin work via `?service=`. Soak. No frontend reads `source` anymore.

---

## PHASE 2D.3 — SDK `0.13.0`: remove deprecated `source`/`CollectionSource`

Depends on 2D.2 deployed (no consumer uses `source`).

### Task 2D.3.1: Strip the deprecated surface

**Files:** `medialane-sdk/src/types/api.ts`, `src/api/client.ts`, `package.json`

- [ ] **Step 1:** In `src/types/api.ts`: delete `export type CollectionSource = …` (~line 61); in `ApiCollectionsQuery` delete `source?: CollectionSource;` (~82, keep `service?: string;` ~84); in `ApiCollection` delete the `/** @deprecated Since 0.12.0 … */` line + `source: CollectionSource;` (~289-290, keep `service: string | null;` ~288).
- [ ] **Step 2:** In `src/api/client.ts`: remove the `CollectionSource` import and the `source` query param/handling in `getCollections`, keeping the `service` param added in 2B.3. Run `grep -n "CollectionSource\|source" src/api/client.ts` and remove each `source`-only reference (leave `service`).
- [ ] **Step 3:** `package.json`: `"version": "0.12.0"` → `"0.13.0"`.
- [ ] **Step 4: Gate:** `cd /Users/kalamaha/dev/medialane-sdk && bun x tsc --noEmit` → 0; `bun run build` → OK; `grep -rn "CollectionSource" src` → no matches.
- [ ] **Step 5: Commit + PR** `feat/2d3-sdk-013` — title "Phase 2D.3: SDK 0.13.0 — remove deprecated CollectionSource/source", body notes it depends on 2D.2 (no consumer uses source) + trailer. Merge; **publish `@medialane/sdk@0.13.0`** (npm, `--access public`, via the documented publish flow; rotate the publish token after) only after 2D.2 is confirmed in prod.

**2D.3 SHIP GATE:** `npm view @medialane/sdk version` = `0.13.0`. dapp + io bump to `^0.13.0` in a follow-up chore (they no longer reference `source`, so it's a clean bump — verify each `tsc`+`build` after bumping).

---

## PHASE 2D.4 — Backend: drop dual-write + `CollectionSource` (IRREVERSIBLE)

Depends on 2D.1–2D.3 deployed + soaked. **Re-run the GLOBAL GATE psql check immediately before this phase.**

### Task 2D.4.1: Stop dual-writing `source`

**Files:** the dual-write sites (`src/mirror/handlers/{popFactory,dropFactory,ip1155Factory,orderCreated1155}.ts`, `src/mirror/index.ts`, `src/orchestrator/collectionMetadata.ts`, `src/api/routes/{collections,admin}.ts`; `src/api/routes/claims.ts` keeps `service: null`, drop its `source:"EXTERNAL"`).

- [ ] **Step 1:** Run `grep -rn 'source: "' src/mirror src/orchestrator/collectionMetadata.ts src/api/routes/collections.ts src/api/routes/admin.ts src/api/routes/claims.ts --include='*.ts'` to list every line. For each, **delete the `source: "<VALUE>",` line, keep the adjacent `service:` line**. (~19 sites.)
- [ ] **Step 2:** Differential tsc → still `8` (baseline; the `source` writes were valid Prisma until 2D.4.2 drops the column — order matters: code stops writing it first, then schema drops it).
- [ ] **Step 3: Commit** on branch `feat/2d4-drop-collectionsource`.

### Task 2D.4.2: Remove `?source=` + serializer `source` from the route

**Files:** `src/api/routes/collections.ts`

- [ ] **Step 1:** Delete `VALID_COLLECTION_SOURCES` (~106), the `const source = c.req.query("source")` line (~119), the validation block (~128), the raw-SQL `source` condition (~138), the ORM `where.source` line (~169), and the `body.source` write path (~402). Keep all the `service` equivalents added in 2D.1.
- [ ] **Step 2:** In `serializeCollection`, delete `source: c.source,` (~497). Keep `service: c.service ?? null,`.
- [ ] **Step 3:** Differential tsc → `8`. Commit.

### Task 2D.4.3: Drop the schema enum + column (the irreversible migration)

**Files:** `prisma/schema.prisma`; new migration.

- [ ] **Step 1:** In `prisma/schema.prisma` delete `enum CollectionSource { … }` (~17-32) and the `source CollectionSource @default(MEDIALANE_REGISTRY)` line (~244).
- [ ] **Step 2:** Hand-author the migration (the documented CLAUDE.md pitfall — don't use `migrate dev`; prod applies via `migrate deploy`): create `prisma/migrations/20260517000000_drop_collection_source/migration.sql`:

```sql
-- Phase 2D.4: retire the legacy CollectionSource. service is now the sole
-- discriminator (05-service-model). marketplaceContract is retained.
ALTER TABLE "Collection" DROP COLUMN "source";
DROP TYPE "CollectionSource";
```

- [ ] **Step 3:** Local disposable DB: `bun x prisma db push --accept-data-loss --skip-generate` then `bun x prisma generate`. Verify column gone: `psql -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='Collection' AND column_name='source';"` → empty.
- [ ] **Step 4:** Differential tsc → `8` (Prisma client regenerated; no code references `source` anymore — confirm via `grep -rn '\.source\b\|CollectionSource' src --include='*.ts' | grep -v marketplaceService` → no matches).
- [ ] **Step 5: Commit + PR** `feat/2d4-drop-collectionsource` — title "Phase 2D.4: drop CollectionSource enum+column (IRREVERSIBLE)", body: re-state the GLOBAL GATE psql precondition, the hand-authored migration rationale, that `marketplaceContract` is retained, differential tsc clean. **Merge only after explicitly re-confirming the soak + psql `0` check.**

**2D.4 SHIP GATE (final):** prod migrate-deploy log shows `20260517000000_drop_collection_source` applied; `curl /v1/collections` serves `service`, no `source`; indexer healthy. **Service-model refactor complete.**

---

## Self-Review

**Spec coverage** (vs `05-service-model.md` + the original §2D + the 2C-surfaced additions): ✅ backend `?service=` filter (2D.1) — the gap flagged across 2C; ✅ all `?source=` frontend query sites migrated, dapp + io, incl. collections filter/launchpad/hooks/admin (2D.2); ✅ SDK deprecated surface removed at 0.13.0 after the documented 2-minor window (2D.3, matches draft §10.4); ✅ stop dual-write + drop `CollectionSource` enum/column, `marketplaceContract` retained (2D.4, matches original 2D.1/2D.2 + draft §10.1); ✅ each sub-phase independently shippable + gated, whole plan gated on the 2C soak + psql precondition (irreversible step double-gated).

**Placeholder scan:** none — the only "enumerate via grep first" steps are deliberate (the authoritative current site list; the exact transformation is fully specified in the table) — this is the same precise-mechanical pattern that executed cleanly in 2C, not vague TODOs. Irreversible bits (migration SQL, route deletions, SDK type deletions) are fully literal.

**Type consistency:** canonical id mapping is one table used identically across 2D.1/2D.2/2D.4; `service` column = `String?` (no enum cast) consistent in backend filter (2D.1) and schema (2D.4); SDK `service: string | null` / `service?: string` retained while `CollectionSource`/`source` removed consistently (2D.3); `marketplaceContract` explicitly retained everywhere `source` is dropped.
