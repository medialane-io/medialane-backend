# Asset / Service Model — Architectural Design

**Status:** Draft for review. Not yet implemented.
**Author:** Claude (with Salvador as design partner)
**Scope:** medialane-backend (Prisma schema, indexer, API), @medialane/sdk (types, service registry), medialane-dapp + medialane-io (consumer cutover)

**Product context:** Medialane is pre-launch. The immediate goal is finishing the first version and bringing creators on board. This refactor exists to give that first version a clean foundation that won't compound debt — not to pre-build for 25 future services. The model is open-ended enough that future services slot in without redesign; the implementation scope is the 4 currently live ones.

---

## 1. First principles

Three principles that constrain every design choice below. These come from Medialane's stated goal: empower humans and AI with permissionless, censorship-resistant, sovereign ownership of digital assets.

### 1.1 The smart contract is the only truth

The platform is a **shell over on-chain state**. The backend database is an index for discovery, search, and aggregation — not authority. The frontend renders a view of on-chain reality, never gates user actions on database state. If the contract accepts a call, the user can make it. If the contract rejects it, the toast handles the error.

**Code consequence:** No predicate in the dapp may say "you can't trade this because our database says it's an external collection." The marketplace contract decides. (Memory: `feedback_medialane_values.md`. Two P0 incidents on 2026-05-15 — a `walletType === "injected"` gate and a `useIsTransferable` gate — both violated this principle and locked production users out of trading.)

### 1.2 Multi-protocol by design

Medialane is a **creators capital markets platform**, not an NFT marketplace. The medialane-contracts repository plans ~25 services (POP, Drop, Ticket, Club, Open Edition, Creator Coins, Subscription, Story, Crowdfunding, …). Each service generates a different shape of digital asset (ERC-721, ERC-1155, future ERC-20). The marketplace must surface and trade any of them through one unified experience.

**Code consequence:** No core schema field may enumerate the services. The catalog of services lives in the SDK (TypeScript), not in a Prisma enum. Adding service #26 = registering a definition. Zero schema migrations.

### 1.3 Programmable metadata

Each service ships its own UI vocabulary — what actions the asset supports, what attributes it carries, what view variant the dapp renders. The dapp already does a hard-coded version of this via `detectAssetType(source, standard)` in `asset-page-client.tsx`. The principle here is to **generalize the dispatcher** so adding a service means registering a definition, not editing dispatcher code.

**Code consequence:** The platform reads service-specific behavior from a registry, never hard-codes it per route. `getService(asset.service)?.uiVariant` instead of `if (source === "POP_PROTOCOL") return "pop"`.

---

## 2. Current state — what's wrong

### 2.1 `CollectionSource` is doing five jobs

Today's `CollectionSource` enum (13 values, only 5 actually written):

| Value | Provenance | Standard | Protocol | Use-case | Notes |
|---|---|---|---|---|---|
| `MEDIALANE_ERC721` | Medialane | ERC721 | — | — | Live |
| `MEDIALANE_ERC1155` | Medialane | ERC1155 | — | — | Live |
| `POP_PROTOCOL` | Medialane | ERC721 | POP | — | Live |
| `COLLECTION_DROP` | Medialane | ERC721 | Drop | — | Live |
| `EXTERNAL` | External | — | — | — | Live |
| `MEDIALANE_REGISTRY` | Medialane | — | — | — | Legacy alias, drift |
| `ERC1155_FACTORY` | Medialane | ERC1155 | — | — | Legacy alias of `MEDIALANE_ERC1155` |
| `EXTERNAL_ERC721`, `EXTERNAL_ERC1155` | External | ERC* | — | — | Never written |
| `PARTNERSHIP`, `IP_TICKET`, `IP_CLUB`, `GAME` | ? | ? | future? | aspirational | Never written |

This conflates five orthogonal axes — **provenance, standard, protocol, use-case, implementation detail** — into a single enum. Adding any one dimension triggers a Cartesian explosion (`POP_ERC721`, `POP_ERC1155`, `DROP_ERC721`, `EXTERNAL_POP_ERC721`, …).

### 2.2 The conflation forces defensive triple-predicates

Three real examples from the current codebase:

**Backend** (`src/orchestrator/collectionMetadata.ts:121`):
```ts
if (existing?.source === "MEDIALANE_ERC1155"
 || existing?.source === "ERC1155_FACTORY"
 || existing?.standard === "ERC1155") { ... }
```

**Dapp** (`src/app/create/asset/page.tsx:129`):
```ts
(c) => c.source === "MEDIALANE_ERC721"
    && c.standard === "ERC721"
    && c.collectionId != null
```

**Dapp** (`src/app/asset/[contract]/[tokenId]/asset-page-client.tsx:16-17`):
```ts
if (source === "POP_PROTOCOL")   return "pop";
if (source === "COLLECTION_DROP") return "drop";
```

There exists a backend helper called `resolveStandardBySource()` whose entire purpose is extracting the standard from the source enum. That helper is the tell — the enum is being asked to imply facts it shouldn't carry.

### 2.3 Order discrimination by string-equality on address

Orders distinguish ERC-721 vs ERC-1155 marketplaces by string-comparing `from_address` against `MARKETPLACE_1155_CONTRACT`. Six call sites do this:

```ts
const is1155 = event.from_address === normalizeAddress(MARKETPLACE_1155_CONTRACT);
```

When a third marketplace ships (e.g., coin trader, auction house, bulk-order), this becomes an N-way address comparison.

---

## 3. The model

Two orthogonal fields on `Collection` (and an analogous one on `Order`). The capability catalog lives in the SDK.

### 3.1 Collection

```prisma
model Collection {
  // … existing identity + metadata fields …

  /// Token standard the contract implements. Detected on-chain via SRC5/ERC-165
  /// and authoritative for the contract's call surface (which ABI to use).
  /// Carries no business meaning beyond "what shape of ABI does this expose".
  standard  TokenStandard  @default(UNKNOWN)

  /// Stable identifier of the Medialane service that deployed or claimed this
  /// collection. Open-ended string — values live in the SDK service registry,
  /// not in a Prisma enum, so adding a new service requires no schema change.
  ///
  /// `null` = external collection (not deployed via any Medialane service).
  /// The platform treats null-service collections as generic standard-based
  /// assets and renders default UI; users can still trade them.
  service   String?
}
```

`TokenStandard` is extended:
```prisma
enum TokenStandard {
  ERC721
  ERC1155
  ERC20      // NEW — for creator coins and similar fungibles
  UNKNOWN
}
```

`CollectionSource` is **dropped** (after data migration). No replacement enum.

### 3.2 Order

```prisma
model Order {
  // … existing fields …

  /// Stable identifier of the marketplace service that produced this order.
  /// Looks up the SNIP-12 domain, fulfillment shape, cancellation semantics.
  marketplaceService  String?    // e.g. "medialane-marketplace-erc721",
                                  //      "medialane-marketplace-erc1155",
                                  //      future "medialane-coin-trader"
}
```

The denormalized `marketplaceContract` address column remains (useful for explorer links and indexer correlation) but **is no longer used to discriminate behavior**. Behavior comes from `marketplaceService` via the SDK registry.

### 3.3 What "service" answers

After the migration, every previously-confused predicate becomes a single registry lookup:

```ts
// Today:                          // After:
source === "POP_PROTOCOL"          getService(c.service)?.id === "pop"
source === "MEDIALANE_ERC721"
  && standard === "ERC721"         getService(c.service)?.id === "mip-erc721"
  && collectionId != null
source === "MEDIALANE_ERC1155"
  || source === "ERC1155_FACTORY"
  || standard === "ERC1155"        c.standard === "ERC1155"
is1155 = event.from_address ===
  MARKETPLACE_1155_CONTRACT        getService(o.marketplaceService)?.standard === "ERC1155"
```

Same answer, one source of truth, no defensive OR-chains.

---

## 4. The service registry pattern

The registry is the heart of the design. It lives in the SDK so dapp, io, third-party integrators, AI agents, and the indexer all consume the same definitions.

### 4.1 `ServiceDefinition`

```ts
// @medialane/sdk
export interface ServiceDefinition {
  /** Stable string ID. Format: kebab-case, lowercase, no version numbers. */
  id: string;

  /** Human-readable name shown in UI. */
  displayName: string;

  /** Short description for service-catalog UIs. */
  description: string;

  /** Token standard this service deploys. */
  standard: TokenStandard;

  /** Derived: MEDIALANE for Medialane-deployed; EXTERNAL for non-service. */
  provenance: "MEDIALANE" | "EXTERNAL";

  /** On-chain coordinates of the service contract (when applicable). */
  onchain?: {
    factoryAddress?: string;       // For services that deploy per-collection contracts
    classHash?: string;            // For services with an upgradeable class
    startBlock?: number;           // Earliest block the indexer should scan
  };

  /** Dapp UI variant identifier. Maps to an asset-page variant + a collection-page variant. */
  uiVariant: "standard" | "edition" | "pop" | "drop" | "coin" | string;

  /** Actions the dapp surfaces for assets from this service. */
  capabilities: ServiceCapability[];

  /** Optional metadata schema — attribute whitelist, license template defaults. */
  metadataSchema?: {
    requiredTraits?: string[];
    licenseDefault?: string;
    aiPolicy?: "permissive" | "restricted" | "custom";
  };
}

export type ServiceCapability =
  | "list" | "buy" | "make_offer" | "cancel"      // Marketplace
  | "transfer" | "burn"                            // Token operations
  | "mint" | "claim" | "airdrop"                   // Issuance
  | "remix" | "license"                            // IP-specific
  | "subscribe" | "redeem";                        // Service-specific
```

### 4.2 The registry

```ts
// @medialane/sdk/src/services/registry.ts
import type { ServiceDefinition } from "../types/api.js";

const SERVICES: Record<string, ServiceDefinition> = {
  "mip-erc721": {
    id: "mip-erc721",
    displayName: "IP Collection",
    description: "Tokenize intellectual property as an ERC-721 collection.",
    standard: "ERC721",
    provenance: "MEDIALANE",
    onchain: {
      factoryAddress: COLLECTION_721_CONTRACT_MAINNET,
      classHash: IPCOLLECTION_CLASS_HASH_MAINNET,
      startBlock: 9196722,
    },
    uiVariant: "standard",
    capabilities: ["list", "buy", "make_offer", "cancel", "transfer", "mint", "remix", "license"],
    metadataSchema: { licenseDefault: "CC-BY-4.0" },
  },
  "mip-erc1155": { /* … */ },
  "pop":         { /* … POP soulbound, capabilities: ["claim", "transfer"]   */ },
  "drop":        { /* … Collection Drop, capabilities: ["claim", "list", …] */ },
  // … future services slot in here. No schema change.
};

/** Lookup. Returns undefined for external/unknown services. */
export function getService(id: string | null | undefined): ServiceDefinition | undefined {
  return id ? SERVICES[id] : undefined;
}

/** Discovery — list all registered services (e.g. for the launchpad). */
export function listServices(): ServiceDefinition[] {
  return Object.values(SERVICES);
}

/** Filter — services that match a capability (e.g. "show services where users can mint"). */
export function getServicesByCapability(cap: ServiceCapability): ServiceDefinition[] {
  return Object.values(SERVICES).filter((s) => s.capabilities.includes(cap));
}
```

### 4.3 Two layers, separated cleanly

The SDK already has `PopService`, `DropService`, `ERC1155CollectionService` classes (`@medialane/sdk/src/services/*.ts`). They are the **imperative** layer — "how do I call this service's contract?" They stay as-is.

The new `ServiceDefinition` registry is the **declarative** layer — "what is this service?" It tells the platform UI and indexer what behavior to expose.

Both layers coexist:
- `PopService.claim(account, address)` — does the tx
- `getService("pop").capabilities.includes("claim")` — knows whether to show the button

Each layer addresses a separate concern. The platform should never check which marketplace contract an order came from to decide if you can cancel it — it should look up the marketplace service's capabilities.

---

## 5. Migration strategy

### 5.1 Prisma migration

One additive migration, one backfill, one cleanup migration. Cannot be combined safely — the backfill needs the new column to exist before `CollectionSource` is dropped.

**Step 1 — Additive migration** (`20260516000000_add_service_column`):
```sql
ALTER TABLE "Collection" ADD COLUMN "service" TEXT;
ALTER TABLE "Order"      ADD COLUMN "marketplaceService" TEXT;
CREATE INDEX "Collection_chain_service_idx" ON "Collection"("chain", "service");
CREATE INDEX "Order_marketplaceService_idx"  ON "Order"("marketplaceService");

-- Extend TokenStandard with ERC20 for creator coins
ALTER TYPE "TokenStandard" ADD VALUE 'ERC20';
```

**Step 2 — Data backfill** (one-time script, idempotent):
```ts
// scripts/backfill-service-id.ts
const BACKFILL: Record<string, { service: string | null; standard?: TokenStandard }> = {
  "MEDIALANE_ERC721":   { service: "mip-erc721",   standard: "ERC721"  },
  "MEDIALANE_ERC1155":  { service: "mip-erc1155",  standard: "ERC1155" },
  "ERC1155_FACTORY":    { service: "mip-erc1155",  standard: "ERC1155" }, // legacy alias
  "MEDIALANE_REGISTRY": { service: "mip-erc721",   standard: "ERC721"  }, // legacy alias
  "POP_PROTOCOL":       { service: "pop",          standard: "ERC721"  },
  "COLLECTION_DROP":    { service: "drop",         standard: "ERC721"  },
  "EXTERNAL":           { service: null            },                     // genuinely no service
  "EXTERNAL_ERC721":    { service: null,           standard: "ERC721"  },
  "EXTERNAL_ERC1155":   { service: null,           standard: "ERC1155" },
  "PARTNERSHIP":        { service: null            }, // was aspirational, never written but defensive
  "IP_TICKET":          { service: null            },
  "IP_CLUB":            { service: null            },
  "GAME":               { service: null            },
};

// For Orders — derive marketplaceService from marketplaceContract:
const MARKETPLACE_BACKFILL: Record<string, string> = {
  [normalizeAddress(MARKETPLACE_721_CONTRACT)]:  "medialane-marketplace-erc721",
  [normalizeAddress(MARKETPLACE_1155_CONTRACT)]: "medialane-marketplace-erc1155",
};
```

The script reads every row, writes the new column, leaves the old column untouched. Safe to re-run.

**Step 3 — Verification window.** Keep `CollectionSource` populated by writes for one deploy cycle. The indexer writes BOTH `source` (old) and `service` (new) during this window. The frontend reads from `service` first, falling back to `source` if `service` is null (shouldn't happen, but belt-and-suspenders for the rollout).

**Step 4 — Cleanup migration** (after verification window):
```sql
ALTER TABLE "Collection" DROP COLUMN "source";
DROP TYPE "CollectionSource";
ALTER TABLE "Order" DROP COLUMN "marketplaceContract"; -- becomes derivable from service
```

(Or — keep `marketplaceContract` as a denormalized link for explorer URLs. Decide during Phase 2.)

### 5.2 SDK deprecation path

`CollectionSource` type and `ApiCollection.source` field are marked `@deprecated` in SDK v0.12.0 but kept (returning a string derived from `service`). `ApiCollection.service: string | null` is added. Consumers migrate at their own pace. SDK v0.13.0 removes `source`.

```ts
// SDK 0.12.0 — transitional
export interface ApiCollection {
  // …
  service: string | null;          // NEW — primary field
  /** @deprecated Since v0.12.0 — use `service`. */
  source?: CollectionSource;       // Derived for back-compat: service → legacy source string
  standard: TokenStandard;         // Existing, unchanged
}
```

### 5.3 Backend handler updates

Each factory event handler writes its service ID. Examples:
- `mirror/handlers/popFactory.ts`: `service: "pop"`
- `mirror/handlers/dropFactory.ts`: `service: "drop"`
- `mirror/handlers/ip1155Factory.ts`: `service: "mip-erc1155"`
- `mirror/handlers/collectionCreated.ts` (the MIP-Collections-ERC721 registry): `service: "mip-erc721"`
- Manual `EXTERNAL` claims via `routes/claims.ts`: `service: null`

`resolveStandardBySource` is deleted — the standard now comes from the service definition (`getService(service)?.standard`) or contract detection (SRC5).

---

## 6. Frontend integration pattern

### 6.1 Asset page dispatcher

```ts
// Today — hard-coded
function detectAssetType(source: string | undefined, standard: string | undefined) {
  if (source === "POP_PROTOCOL")    return "pop";
  if (source === "COLLECTION_DROP") return "drop";
  if (standard === "ERC1155")        return "edition";
  return "standard";
}

// After — registry-driven
function detectAssetType(service: string | null | undefined, standard: TokenStandard) {
  return getService(service)?.uiVariant
      ?? (standard === "ERC1155" ? "edition" : "standard");
}
```

Adding service variant #5: register the service definition with `uiVariant: "ticket"`, add the variant component file. **Zero changes to the dispatcher.**

### 6.2 Action button rendering

```ts
// Today — every page hard-codes which buttons to show
{isOwner && (collection.source === "MEDIALANE_ERC721"
          || collection.source === "MEDIALANE_ERC1155") && <RemixButton />}

// After — capability lookup
{isOwner && getService(collection.service)?.capabilities.includes("remix") && <RemixButton />}
```

### 6.3 Launchpad

The launchpad page becomes a render of `listServices()` rather than a hard-coded grid of POP / Drop / NFT Editions tiles. New services appear automatically when registered.

---

## 7. Service catalog

### 7.1 Active services (active on mainnet, MUST be in SDK v0.12.0)

| Service ID | Display name | Standard | UI variant | On-chain | Issuance model |
|---|---|---|---|---|---|
| `mip-erc721` | IP Collection | ERC721 | standard | MIP-Collections-ERC721 registry | Many collections, each owned by one creator who mints into their own |
| `mip-erc1155` | NFT Editions | ERC1155 | edition | ERC1155 collection factory | Many collections, each owned by one creator who mints editions |
| `ip-erc721` | Programmable IP (genesis) | ERC721 | standard | IP-Programmable-ERC-721 (single contract) | One shared collection, many wallets can mint genesis pieces |
| `pop` | POP Protocol | ERC721 | pop | POP factory | Soulbound proof-of-presence per event |
| `drop` | Collection Drop | ERC721 | drop | Drop factory | Sequential mint with claim windows + allowlist |

**Note on the two ERC-721 services:** `mip-erc721` and `ip-erc721` deploy different contract architectures. MIP is a registry that deploys a new per-creator collection contract on every `create_collection`, with that creator as the sole minter. IP-Programmable-ERC-721 is a single contract everyone mints into — the "genesis" pattern. The service ID makes them distinguishable in one field; the dapp's `getService(asset.service).issuanceModel` (or similar capability) determines whether minting is gated to a single owner or open.

### 7.2 Marketplace services

| Service ID | Standard | Notes |
|---|---|---|
| `medialane-marketplace-erc721` | ERC721 | Existing marketplace contract |
| `medialane-marketplace-erc1155` | ERC1155 | Existing 1155 marketplace contract |

### 7.3 Parking lot — IDs for future services (NOT a commitment)

These contracts exist in mediolano-contracts but haven't been deployed/indexed yet, and most haven't been designed end-to-end. The IDs below are **proposed names**, not reserved slots. They're listed here only so the implementer of the first one has a starting point — every ID below is open to change when the service is actually designed. **Do not write code against any of these in v0.12.0.**

| Contract | Reserved service ID | Likely standard |
|---|---|---|
| IP-Tickets | `ticket` | ERC721 |
| IP-Club | `club` | ERC721 |
| IP-Story | `story` | ERC721 |
| IP-Subscription | `subscription` | ERC721 |
| IP-Crowfunding | `crowdfunding` | ERC20 or ERC721 |
| IP-Revenue-Share | `revenue-share` | ERC20 |
| IP-Airdrop | `airdrop` | (varies by airdrop) |
| IP-Time-Capsule | `time-capsule` | ERC721 |
| IP-Sponsorship | `sponsorship` | ERC721 |
| IP-Syndication | `syndication` | ERC721 |
| IP-Leasing | `leasing` | ERC721 |
| IP-Franchise-Monetization | `franchise` | ERC20 |
| IP-Commission-Escrow | `commission` | (escrow, no asset) |
| IP-Colab-Collections | `colab` | ERC1155 |
| IP-Programmable-ERC-721 | (alias of mip-erc721?) | TBD |
| IP-Programmable-ERC-1155 | (alias of mip-erc1155?) | TBD |
| MIP-Openedition-ERC721a | `open-edition` | ERC721 |

Some `IP-*` contracts (License-Agreement, Collective-Agreement, Negotiation-Escrow, Smart-Transaction, Marketplace-Auction, Marketplace-Bulk-Order, Marketplace-Public-Profile, Offer-Licensing) are **not** asset-generating services — they're protocol extensions of the marketplace or licensing layer. They don't get service IDs; they integrate as marketplace services or as capabilities on existing services.

User identity contracts (User-Settings, User-Public-Profile, User-Achievements, Partner-Certification, IP-ID) are also out of scope — they're profile/identity, not asset issuance.

### 7.4 Naming conventions

- **Format:** kebab-case, lowercase, no version numbers (`mip-erc721`, not `mip-erc721-v3`).
- **Versioning:** When a service contract gets a new audit/version, the **service ID stays the same**. The `onchain.factoryAddress` / `classHash` in the registry definition updates. Database rows carry the same service ID across the contract migration. This is what made the v3 audit migration painful — the schema baked the version into the source enum.
- **No "v3" / "audit" / "cutover" in IDs.** (Memory: `feedback_medialane_values.md` — code names behavior, not migration history.)

---

## 8. Adjacent cleanups

### 8.1 In scope for this work

- **`OrderStatus.COUNTER_OFFERED`** — bake counter-offers into the service capability model rather than the core order lifecycle. Specifically: counter-offers are a workflow expressed via two linked orders (the original bid + the seller's counter), not a third lifecycle state. The `parentOrderHash` already links them. Drop `COUNTER_OFFERED` from `OrderStatus`; UI groups orders by `parentOrderHash` to display counter-offer threads.

- **`IntentType`** — keep the existing values as-is for v0.12.0 (they're not blocking the service model), but plan for v0.13.0 to make intent types per-service. New service launches its own intent types; the platform routes them via service registry.

### 8.2 Out of scope (separate work)

- **`Chain` enum** — fine as-is. Multi-chain ready, only Starknet exercised, no pressure to refactor.
- **`MetadataStatus`** — small bounded lifecycle, no orthogonal concerns crammed in. Leave alone.
- **`ReportTargetType`, `ReportCategory`** — small bounded enums for moderation. Fine.
- **`IndexerCursor`, `Job` table, orchestrator job types** — internal machinery, not user-facing concepts. Don't redesign.
- **Splitting `use-marketplace.ts`** — separate plan, unrelated to this model.

---

## 9. Migration risk + rollback

| Risk | Mitigation |
|---|---|
| Backfill miscategorizes some external collections as Medialane | Backfill is dry-run-able. Spot-check with admin queries before commit. |
| Frontend reads `service` before backend writes are deployed | Roll out backend first; SDK 0.12.0 added field is optional; frontends migrate over the next sprint. |
| A previously-uncategorized collection is missing from the registry | Frontend falls back to `standard`-based generic UI when `service` is null. No user-blocking failure. |
| Counter-offer cleanup breaks portfolio counter-offers tab | Refactor and verify in a separate commit *after* the schema migration is stable. Don't bundle. |

Rollback for Phase 2 (schema):
- Steps 1+2 (additive) are rollback-safe — adding columns + writing data, never destructive.
- Step 4 (drop `CollectionSource`) is the only destructive step. Trigger it only after at least one full deploy cycle reading from `service` in production.

---

## 10. Decisions (locked 2026-05-15)

1. **`marketplaceContract` column** — **Keep** as a denormalized explorer-link helper. Explorer URLs are concrete addresses, and decoupling the user-facing link from the service-routing field is cleaner than reusing one column for both.

2. **Service capability schema** — `capabilities` is a **typed enum** (`ServiceCapability` string union in TypeScript). Capabilities are a small bounded set shared across all services; consumers benefit from autocomplete and exhaustiveness checking. Services that need behaviour outside the bounded set are a signal that the capability list itself should expand, not that capabilities should become free-form.

3. **Service registry location in SDK** — `src/services/registry.ts` alongside the existing `pop.ts` / `drop.ts` imperative service classes. The registry imports no service classes (no circular dependency); service classes may optionally import their own definition from the registry to read their factory address.

4. **Backward-compat duration for `ApiCollection.source`** — **Two SDK minor versions** (0.12.0 + 0.13.0), removed in 0.14.0. Adds one release of soak time for any third-party integrators we don't know about. Marked `@deprecated` at 0.12.0; consumers see TypeScript warnings throughout the transition.

5. **`IP-Programmable-ERC-721` vs `mip-erc721`** — **Two distinct services** (`ip-erc721` + `mip-erc721`). Different issuance models, different contract architectures. See §7.1 for the catalog entries and the distinction.

---

## 11. Phase plan (for a follow-up implementation doc)

Once this design is approved, the implementation plan is straightforward:

- **Phase 2a — Backend** (1-2 days): Prisma migration (additive), `ServiceDefinition` types in SDK, backfill script, indexer handlers write `service`. Old `source` writes continue.
- **Phase 2b — SDK v0.12.0** (½ day): Add `service` field to `ApiCollection`, add `ServiceDefinition` + registry, export `getService()` / `listServices()`. Mark `source` `@deprecated`.
- **Phase 2c — Frontend cutover** (1 day): dapp + io migrate predicates to `getService()`. Asset page dispatcher reads from registry. Action buttons read from capabilities.
- **Phase 2d — Cleanup** (½ day, after a deploy cycle of soak time): drop `CollectionSource` enum + column, SDK v0.13.0 removes deprecated alias.

Total: ~4 dev-days, low risk per step because every step ships independently and ships value before the next.

---

**Next action:** Salvador reviews this doc. We iterate on §10 (open questions) and any §7 (catalog) corrections. Then I write the Phase 2 implementation plan that breaks 2a–2d into bite-sized tasks.
