# 02 — Protocol / App Split

**Status:** Draft for review. Builds on `00-principles.md` and `01-core-model.md`.

---

## What this is

`00 §1` says the contract is the only truth and everything else is a shell. This document makes that concrete: for each of the six primitives in `01`, **what lives on-chain, what lives in the indexer, what lives in the SDK, and what lives in the apps** — and, just as important, what is *not allowed* to live in each layer.

If `01` is the *nouns*, this is *where each noun's authoritative copy sits and where its caches sit*.

---

## I. The four layers

| Layer | Repo(s) | Role | Authority? | Rebuildable? |
|---|---|---|---|---|
| **Chain** | `medialane-contracts`, `mediolano-contracts` | The protocol. Holds state, enforces the rules it chooses to enforce, emits Events. | **Yes — the only authority.** | No. It *is* the source. |
| **Indexer** | `medialane-backend` | Reduces Events into a queryable projection (PostgreSQL). Caches metadata, aggregates stats. | No. A cache. | **Yes — replay Events.** |
| **SDK** | `medialane-sdk` | Typed access to the protocol + the **service registry**. The protocol's public, machine-readable surface. | No. A lens. | Yes. Code. |
| **Apps** | `medialane-dapp`, `medialane-io`, `medialane-portal` | Views and authoring UX over the SDK. House rules, presentation, platform-layer fees. | No. A renderer. | Yes. Code. |

**The one rule that generates the rest:** authority only ever flows *down* this table. The chain never asks the indexer whether something is allowed. The indexer never invents state the chain didn't emit. The apps never gate a protocol action on something only they know (`00 §1`).

**Corollary — the rebuild test:** if the PostgreSQL database is dropped, every row must be reconstructable by replaying on-chain Events (plus re-fetching the off-chain metadata they point to). Any field that *cannot* be rebuilt this way is either (a) legitimately platform-layer state (a Profile, a slug claim, an API key) or (b) a §1 violation. There is no third category.

---

## II. Where fees live

Called out on its own because it is the most common place the split gets violated.

Per `00 §12`: the marketplace and Launchpad **protocols are zero-fee**. Fees are an **app/SDK-layer** concern, applied at settlement time by the platform, and the fuller schedule is still undecided. Consequences for this document:

- **Chain:** no fee logic. A fee hardcoded in an immutable contract is unremovable and gates a permissionless action.
- **Indexer:** records what was settled (amounts, tokens, recipients as they appear on-chain). It does not *compute* a fee as authoritative state — it can derive a display figure, clearly marked as derived.
- **SDK / Apps:** where a fee, if any, is added to a quote before the user signs. Changing the fee schedule is a code/config change here, never a contract migration.

A third-party client that doesn't apply Medialane's fee is not breaking the protocol — it's exercising `00 §5`. That is by design, not a leak to plug.

---

## III. The split, primitive by primitive

For each primitive: **authoritative on-chain**, **projected by the indexer**, **exposed by the SDK**, **rendered by the apps**.

### Asset

| Layer | Holds |
|---|---|
| Chain | Existence, `owner` / balances, `tokenURI`. The truth of "who owns what." |
| Indexer | `Collection` / `Token` rows: cached owner, cached resolved metadata, derived stats (floor, volume, holders), attributed `service`. All rebuildable. |
| SDK | Typed asset reads, `getLicense(metadata)`, the `(chain, contract, tokenId)` ↔ future `IP-ID` resolution. |
| Apps | The asset page (variant chosen by `service`), media rendering, the trade UX. |

Off-chain **metadata** (IPFS/Arweave, pointed to by `tokenURI`) is authoritative *for its own content* but is not platform state — the indexer caches a copy and may serve it stale; the pointer on-chain is the truth.

**Not allowed:** an Asset that exists only as an indexer row with no on-chain counterpart; an owner served from the DB when the caller needs to *act* (acting reads owner from chain).

### Account

| Layer | Holds |
|---|---|
| Chain | Wallets (addresses + signing). Future `AccountID` attestations linking Wallets. |
| Indexer | The aggregation: Wallets → Account, reputation/XP, sales history. `AccountProfile` / `CreatorProfile`, slug claims, roles. |
| SDK | Account resolution, attestation verification, profile reads. |
| Apps | Profile pages, authoring tools gated by **role** (creator-role UX) — never by protocol permission. |

Profile, roles, reputation, slug claims, API keys: **legitimately platform-layer state.** They are *not* §1 violations because they grant no protocol authority — losing them loses no ownership, no Order, no history (`01 §II`). They are the (a) category of the rebuild test.

**Not allowed:** a role or profile flag that decides whether a wallet *can trade* (`00 §1, §2`). Roles gate UI affordances only.

### Service

| Layer | Holds |
|---|---|
| Chain | The deployed contracts a service points to (factory, class hash, start block). |
| Indexer | Per-service event parsers; `service` attribution on indexed assets/orders. |
| SDK | **The service registry** — the authoritative *description* of services (id, standard, capabilities, on-chain coordinates, UI variant). Year 1: TypeScript. Year 2+: on-chain registry contract. |
| Apps | Launchpad listing, routing (`uiVariant` → asset-page variant), capability-driven action buttons. |

The service registry is the protocol's self-description and the seam agents read (`00 §6`). It is the one place where the SDK is *more* than a lens — until the registry moves on-chain, the SDK is its custodian. That is an explicit, dated year-1 compromise (`01 §IX`), not a hidden authority.

**Not allowed:** routing or settlement that string-compares contract addresses instead of resolving through the registry (`01 §X`).

### License

| Layer | Holds |
|---|---|
| Chain | The `tokenURI` pointer. Selective enforcement hooks *only where a specific service opts in* (`00 §9`). |
| Indexer | Parsed license attributes cached for query speed (`Token.licenseType` etc.) — derived, not authoritative. |
| SDK | `getLicense(asset.metadata)` — the typed view. |
| Apps | License display, mint-time selection/customization, soft enforcement (house rules). |

The License is **data on the Asset, not a layer of its own** (`01 §IV`). It has no authoritative home separate from the Asset's metadata. The Berne-aligned authorship/ownership claims are immutable because the metadata is immutable (`00 §13`), not because a database row says so.

**Not allowed:** a `License` table with a foreign key to Asset that can drift from metadata (`01 §X`).

### Order

| Layer | Holds |
|---|---|
| Chain | The signed order, its parameters, its lifecycle transitions (created / fulfilled / cancelled). The marketplace contract is the matcher. |
| Indexer | Denormalized `Order` rows for query speed: status, price, parties — all reconstructable from Events + `get_order_details`. |
| SDK | Order construction, SNIP-12 typed-data signing (domain looked up via `marketplaceService`), fulfillment shape. |
| Apps | Listing/offer UX, the platform-layer fee added to the quote, order threads (`parentOrderHash`). |

`orderHash` is chain-derived and permanent. The indexer's status is a *projection* of on-chain reality — if they disagree, the chain wins and the indexer is reconciled, never the reverse.

**Not allowed:** an Order that the indexer treats as `FULFILLED` without a corresponding on-chain event; an Order bound to a `marketplaceContract` address instead of a `marketplaceService` id (`01 §X`).

### Event

| Layer | Holds |
|---|---|
| Chain | The Events themselves — `(chain, txHash, logIndex)`, permanent, re-readable. |
| Indexer | The reducer: poller → parser → handler → atomic DB write + cursor advance. The `(serviceId, eventName) → parser` table. |
| SDK | — (Events are an indexer-internal concern; the SDK exposes their *effects*, not raw logs.) |
| Apps | — (Apps see projected state, not Events.) |

Event is the primitive with **no app or SDK presence by design**. It is the mechanism by which truth crosses from chain to platform (`01 §VI`). The indexer is, fundamentally, the only consumer of raw Events; everything above consumes the *projection*.

**Not allowed:** an app or SDK path that writes platform state in response to anything other than an indexed Event (e.g. optimistically marking an order sold on a tx hash the indexer hasn't confirmed) — that manufactures unbacked state.

---

## IV. The reconciliation contract

Because the indexer is a cache, "is the cache correct?" must be a well-defined question:

```
Events on chain  →  replay  →  expected DB state
                                      ‖
                            actual DB state  →  diff → reconcile
```

- **Cursor:** `IndexerCursor` tracks the last reduced block. Reset moves it back; it never deletes data — the next pass overwrites with re-derived truth.
- **Backfill:** historical gaps are closed by scanning past Events (`POST /admin/collections/backfill-registry` is the existing instance of this pattern).
- **JIT resolution:** metadata can be fetched on demand (`?wait=true`) but the *result is still cached*, never treated as a parallel source of truth.

If a reconciliation can't be defined for a piece of state, that state doesn't belong in the indexer (it belongs in the platform-layer category, or it's a §1 violation).

---

## V. Year-1 reality

| Concern | v1 | Year 2+ |
|---|---|---|
| Indexer | Single Starknet worker, hand-coded per-service parsers | Multi-chain workers; data-driven parser registry from Service definitions |
| Service registry | TypeScript module in the SDK | On-chain registry contract, permissionless writes |
| `AccountID` / `IP-ID` | Off-chain heuristics; primary wallet = account | On-chain joins |
| Fees | 1% marketplace at platform layer; rest undecided | DAO-governed schedule, still platform-layer |
| Platform-layer state | Profiles, slugs, API keys, XP in PostgreSQL | Same — these are legitimately off-chain |

The architecture supports the right column. v1 ships the left. Nothing in the left column makes the right column unreachable — that is the test every entry here must pass.

---

## VI. What this rules out (cross-cutting)

- **Authority flowing upward.** A contract that reads platform state to decide a call. The arrow only points down (§I).
- **Unbacked state.** Any indexer/app row that can't be traced to an Event or honestly classified as platform-layer (§IV rebuild test).
- **Fee in the contract.** Immutable, permissionless-gating, migration-proof in the bad sense (`00 §12`, §II here).
- **The indexer as a second source of truth.** When DB and chain disagree, chain wins, always, by reconciliation — never patch the chain's "view" to match the DB.
- **Address-equality routing.** Resolving services/orders by comparing contract addresses instead of the registry (`01 §X`).
- **Apps inventing protocol rules.** House rules and soft enforcement are fine and expected; a "rule" that other clients of the same protocol can't see or are forced into is not (`00 §5`).

---

## VII. Related documents

- `00-principles.md` — §1 (contract is truth), §5 (protocol-first), §9 (soft enforcement), §12 (fees at platform layer), §13 (Mediolano substrate)
- `01-core-model.md` — the six primitives this document places into layers
- `03-interoperability.md` — the metadata baseline the Asset/License rows cache
- `05-service-model.md` — the service registry in depth (the SDK's one custodial responsibility)
- `07-identity-model.md` — Account/Wallet/Profile split and `AccountID`
- `08-dao-governance.md` — who governs the registry and the (open) fee schedule

---

**Next document:** `03-interoperability.md` — the OpenSea metadata baseline and Medialane's attribute extensions: the exact shape of what the Asset layer caches and the License layer reads.
