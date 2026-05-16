# 05 — Service Model

**Status:** Draft for review. Builds on `00-principles.md` (§5 protocol-first, §6 agents, §8 interoperability), `01-core-model.md` (§III Service), `02-protocol-app-split.md` (the SDK is the registry's custodian), `04-licensing-model.md` (a service declares its license default + opt-in enforcement here).

**Relationship to the 2026-05-15 draft:** that draft (`2026-05-15-asset-service-model.md`) is the seed and its **§10 decisions are honored as already-locked**. This document rescopes it onto the locked principles and applies two supersedes:
- **Service IDs are the long forms from `01 §III`** (`pop-protocol`, `drop-collection`, …), not the draft's short forms (`pop`, `drop`).
- **License default is `CC BY-SA`** (`04 §III`), not the draft's `CC-BY-4.0` example.

The draft's §5/§11 (migration + phase plan) remain the *implementation* plan; this is the *architecture*.

---

## What this is

The Service primitive in depth: what a service definition is, where it lives, the bounded capability set, how a service declares its asset shape and enforcement, and why a Venue is just a Service. `01 §III` introduced it; this is the full specification.

The governing principle (`00 §5`): **the protocol grows by adding services, not by editing existing code. A service is a registry entry, not a schema migration.**

---

## I. The two orthogonal fields (and what's *not* a field)

From the draft §3, locked. The core schema carries exactly two service-related facts, both open-ended:

| Field | On | Source of truth | Meaning |
|---|---|---|---|
| `standard` | `Collection` | On-chain SRC5/ERC-165 detection | The ABI call surface: `ERC721` · `ERC1155` · `ERC20` · `UNKNOWN`. Carries no business meaning. |
| `service` | `Collection` | Indexer-attributed at index time | Open-ended **string**, resolved in the SDK registry. `null` = external. |
| `marketplaceService` | `Order` | Indexer-attributed | Open-ended string → the marketplace service that produced the order. |

**What is deliberately *not* a field:** an enum of services. The old `CollectionSource` (13 values, 5 axes conflated — draft §2.1) is dropped. Enumerating services in a Prisma enum is the original sin this model exists to undo: it triggers a Cartesian explosion and bakes migration history into the schema (`00 §5`, memory `feedback_medialane_values`). Adding service #26 must be **zero schema migrations**.

`marketplaceContract` stays as a denormalized explorer-link column (draft §10.1, locked) — but never as a behavior discriminator. Behavior comes from `marketplaceService` via the registry (`01 §X`).

---

## II. The ServiceDefinition

The authoritative *description* of a service. Year 1: a TypeScript record in the SDK (`@medialane/sdk`, `src/services/registry.ts`). Year 2+: an on-chain registry contract (`00 §2`, §VII below). The SDK is its sole custodian until then — the one place the SDK is more than a lens (`02 §III Service`), an explicit dated compromise.

```ts
export interface ServiceDefinition {
  id: string;                       // kebab-case, lowercase, NO version number
  displayName: string;
  description: string;
  standard: TokenStandard;          // ERC721 | ERC1155 | ERC20 | UNKNOWN
  provenance: "MEDIALANE" | "EXTERNAL";
  onchain?: {
    factoryAddress?: string;
    classHash?: string;
    startBlock?: number;
  };
  uiVariant: string;                // "standard" | "edition" | "pop" | "drop" | …
  capabilities: ServiceCapability[];
  metadataSchema?: {
    requiredTraits?: string[];
    licenseDefault?: string;        // canonical default is "CC BY-SA" (04 §III)
    enforcement?: EnforcementDeclaration;   // see §IV
  };
}
```

**ID stability (draft §7.4, locked).** When a service contract gets a new audit/version, **the `id` stays the same**; only `onchain.factoryAddress`/`classHash` update. DB rows keep the same `service` string across the contract migration. No `-v3` / `-audit` / `-cutover` in IDs — code names behavior, not migration history (memory `feedback_medialane_values`). This is precisely what made the v3 audit migration painful before.

### Two layers, separated (draft §4.3, locked)

- **Declarative** — the `ServiceDefinition` registry: *"what is this service?"* Drives UI variant, capability buttons, indexer attribution, agent discovery.
- **Imperative** — the existing `PopService` / `DropService` / `ERC1155CollectionService` classes: *"how do I call this contract?"*

They coexist and never collapse into each other. `getService("pop-protocol").capabilities.includes("claim")` decides whether to show the button; `PopService.claim(...)` does the transaction. The platform never inspects which marketplace contract an order came from to decide if it's cancellable — it reads the marketplace service's capabilities (`01 §X`).

---

## III. The capability set

Bounded, typed string union (draft §10.2, locked). Not free-form: a typed set gives agents (`00 §6`) and consumers exhaustiveness and autocomplete. A service needing behavior outside the set is a signal to **expand the set**, not to make it free-form (mirrors `01 §III`, `04 §II`).

| Capability | Meaning |
|---|---|
| `list` | Owner can list the asset for sale via the service's preferred venue |
| `buy` | A buyer can purchase a listed asset |
| `make_offer` | A user can post a bid |
| `cancel` | An offerer/owner can cancel an order |
| `transfer` | An owner can transfer the asset |
| `burn` | An owner can destroy the asset |
| `mint` | A user (per service rules) can issue new assets |
| `claim` | A user can claim under service-specific conditions (POP attendance, Drop window) |
| `airdrop` | The service supports batch issuance |
| `remix` | The asset can parent a derivative |
| `license` | License terms can be exercised through the service |
| `subscribe` | Recurring-access services (IP Club, subscriptions) |
| `redeem` | Redeemable assets (tickets) |

Capabilities gate **UI affordances and routing only**, never protocol permission. Any Account that owns an asset can transfer it whether or not its service lists `transfer` — the contract is the authority (`00 §1`, `01 §II` roles note). A capability missing from a service means "don't surface this button," not "this is forbidden."

---

## IV. How a service declares its asset shape and enforcement

`metadataSchema` is the seam between the Service model and `03`/`04`:

- **`requiredTraits`** — traits a mint through this service must include (on top of the `03` baseline). Additive only; never removes baseline fields (`03 §III`).
- **`licenseDefault`** — the preset a mint defaults to. Canonical platform default `CC BY-SA` (`04 §III`); a service may set a different preset but encodes it as the same plain traits.
- **`enforcement`** — the explicit declaration that *this service's contract is stricter than the soft default*. Per `04 §V`, default services do not enforce; a service that bakes in royalty splits / escrow / time-lock / revocation **must declare it here** so the platform, agents, and third parties can see the stricter behavior:

```ts
type EnforcementDeclaration = {
  royalty?: "erc2981" | "service-split" | "none";   // default "none"
  escrow?: boolean;
  timeLock?: boolean;
  revocable?: boolean;
};
```

Absence of `enforcement` (or all-`none`/false) means soft enforcement — the `00 §9` default. Enforcement is never silently true on a default path.

---

## V. Venues are Services (no separate primitive)

`01 §III`, `01 §X`, locked. A marketplace contract (ERC-721 marketplace, ERC-1155 marketplace, future auction house, future coin trader) is a Service with marketplace capabilities (`["list","buy","make_offer","cancel"]`). It matches Orders instead of issuing Assets — same primitive, different capabilities.

An `Order.marketplaceService` is the routing key: it resolves the SNIP-12 domain, fulfillment shape, cancellation semantics, and matching contract. No address string-comparison anywhere (the draft §2.3 catalogued six call sites doing `from_address === MARKETPLACE_1155_CONTRACT` — all replaced by `getService(o.marketplaceService)?.standard`). `06-venue-model.md` covers venue-specific surface (bulk orders, auctions); the *primitive* is settled here.

---

## VI. Service catalog (canonical IDs)

Reconciled to `01 §III` long-form IDs. Active on mainnet, must be in the registry:

| Service ID | Display | Standard | UI variant | Issuance model |
|---|---|---|---|---|
| `mip-erc721` | IP Collection | ERC721 | standard | Registry deploys a per-creator collection; that creator is sole minter |
| `mip-erc1155` | NFT Editions | ERC1155 | edition | Per-creator collection; creator mints editions |
| `ip-erc721` | Programmable IP (genesis) | ERC721 | standard | One shared contract; many wallets mint genesis pieces |
| `pop-protocol` | POP Protocol | ERC721 | pop | Soulbound proof-of-presence per event |
| `drop-collection` | Collection Drop | ERC721 | drop | Sequential mint, claim windows + allowlist |

Marketplace services: `medialane-marketplace-erc721`, `medialane-marketplace-erc1155`.

**`mip-erc721` vs `ip-erc721` are two distinct services** (draft §10.5, locked): different contract architectures (per-creator registry vs single shared genesis contract). The service ID makes them distinguishable in one field; issuance behavior is read from the definition, never hardcoded per route.

Future IDs (IP-Tickets, IP-Club, IP-Story, …) are a **parking lot, not reservations** (draft §7.3) — proposed names, open to change when each service is actually designed. Do not write code against them.

---

## VII. Year-1 reality

| Concern | v1 | Year 2+ |
|---|---|---|
| Registry location | TypeScript in `@medialane/sdk` (`src/services/registry.ts`) | On-chain registry contract |
| Registration | Medialane/DAO adds a definition | Permissionless on-chain registration; UI surfaces reputation-ranked (`00 §2`) |
| Catalog | 5 active + 2 marketplace services | Grows by registration, never by migration |
| Parser table | Hand-coded per service (`02 §V`) | Data-driven from the service definition |
| `source` back-compat | `ApiCollection.source` `@deprecated` for two SDK minors (draft §10.4) | Removed; `service` only |

The architecture supports the right column today. v1 ships the left. The registry being SDK-resident in v1 is a declared, dated compromise (`02 §III`), not hidden authority — anyone can read it; year 2 moves write access on-chain.

---

## VIII. What this rules out

- **A service enum in the schema.** The Cartesian-explosion / migration-history sin this model undoes (`00 §5`, §I).
- **Address-equality routing.** Discriminating venues/orders by comparing contract addresses instead of `marketplaceService` (`01 §X`, §V).
- **Version numbers in service IDs.** `mip-erc721-v3` bakes migration history into behavior naming (§II, memory `feedback_medialane_values`).
- **Free-form capabilities.** Outside-the-set behavior expands the typed set; it doesn't make capabilities a string bag (§III).
- **Capabilities as protocol gates.** They gate UI/routing only; the contract authorizes actions (`00 §1`, §III).
- **External (`service: null`) as second-class.** External assets are first-class and tradeable (`01 §I`); a null service renders generic UI, never a block.
- **Silent enforcement.** A stricter-than-default contract must declare `metadataSchema.enforcement` (`04 §V`, §IV).

---

## IX. Open questions deferred

- **Capability set evolution** — when to add a new capability vs decompose an existing one. Decided per-addition against §III's "expand, don't free-form" rule; not pre-enumerated.
- **On-chain registry shape** — the year-2 contract's exact storage/write-permission model. Out of v1 scope; surfaces in `08-dao-governance.md` and a year-2 doc.
- **Per-service intent types** — draft §8.1 plans v0.13.0 per-service intent routing; that's an implementation-plan concern, not an architecture change here.

---

## X. Related documents

- `00-principles.md` — §5 (protocol-first), §6 (agents read the registry), §2 (permissionless / year-2 on-chain registry)
- `01-core-model.md` — §III (Service), §X (no separate marketplace primitive, no address routing)
- `02-protocol-app-split.md` — the SDK as the registry's sole custodian until year 2
- `04-licensing-model.md` — `licenseDefault`, and the enforcement declaration this model carries
- `06-venue-model.md` — marketplace venues as Services: bulk orders, auctions, future coin trader
- `08-dao-governance.md` — DAO curation of the registry; year-2 decentralization of registration
- `2026-05-15-asset-service-model.md` — the seed draft + the implementation/migration plan (§5, §11)

---

**Next document:** `06-venue-model.md` — marketplace venues as composable Services: the 1+1 order shape today, where it generalizes (bulk orders, auctions, future coin trader), and the routing model that makes adding a venue a registry entry, not a fork.
