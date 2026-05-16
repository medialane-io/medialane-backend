# 06 — Venue Model

**Status:** Draft for review. Builds on `00-principles.md` (§5 protocol-first, §6 agents), `01-core-model.md` (§V Order), `05-service-model.md` (§V venues are Services).

---

## What this is

How marketplace venues work as **composable Services**: the Order shape today, where and how it generalizes (bulk orders, auctions, a future coin trader), and the routing model that makes adding a venue a registry entry rather than a code fork.

`05 §V` settled the *primitive* claim — a venue is a Service with marketplace capabilities, not a new primitive. This document is the venue-specific surface that claim implies.

Governing principle (`00 §5`, `01 §X`): **the venue an Order belongs to is resolved through `Order.marketplaceService`, never by comparing contract addresses. Adding a venue is registering a Service.**

---

## I. A Venue is a Service (recap, then forward)

From `05 §V`, locked: a marketplace contract is a Service with capabilities `["list","buy","make_offer","cancel"]`. It matches Orders instead of issuing Assets. Everything `05` says about ServiceDefinition (stable id, no version in id, registry-resident in v1, capability gating UI-not-protocol) applies unchanged.

What's venue-specific and owned here: the **Order lifecycle**, the **order shape and its generalization**, and the **per-venue signing/fulfillment** that `Order.marketplaceService` resolves.

---

## II. The Order shape today (1+1)

From `01 §V`, the current Order is `(offer_item, consideration_item)`:

- one Asset (or fungible amount) offered
- one Asset (or fungible amount) demanded
- time bounds (start, end)
- offerer Wallet (`01 §II`)
- optional binding fulfiller, or null (open offer)

A simpler subset of SeaPort's N+N model. It covers fixed-price NFT sales, single-NFT bids, and ERC-20↔ERC-721 swaps. It does **not** cover bundles, multi-item swaps, criteria offers, or conditional orders. `01 §V` states this; this document does not pretend otherwise.

`orderHash` (SNIP-12-derived, per chain) is the identity — unique, permanent (`01 §V`). The indexer's denormalized `Order` row is a projection, reconstructable from Events + `get_order_details` (`02 §III Order`). When chain and index disagree, chain wins by reconciliation (`02 §IV`).

---

## III. Order lifecycle

Canonical statuses (`01 §V`): **`ACTIVE` · `FULFILLED` · `CANCELLED` · `EXPIRED`**.

`COUNTER_OFFERED` is **not** a fifth status. Per the 2026-05-15 draft §8.1 (locked) and `01 §V`: a counter-offer is a *workflow expressed via two linked Orders* — the original bid plus the seller's counter — joined by `parentOrderHash`. The UI groups a thread by `parentOrderHash`; status stays in the four canonical values. Cramming a feature-specific value into the core lifecycle is the conflation this model rejects (same family of mistake as the service enum in `05 §I`).

```
counter-offer thread = Order(bid)  ◄── parentOrderHash ──  Order(seller counter)
                       both carry one of the 4 canonical statuses
```

---

## IV. Per-venue resolution (the routing model)

`Order.marketplaceService` is the single routing key. From it, the SDK/platform resolves everything venue-specific:

| Resolved from `marketplaceService` | Example |
|---|---|
| SNIP-12 domain | ERC-721 venue → `{ name:"Medialane", version:"1" }`; ERC-1155 → `version:"2"` |
| Fulfillment shape | how `register_order` calldata is laid out for that venue |
| Cancellation semantics | what cancelling means for this venue |
| Matching contract | which contract address actually settles |
| Token-standard of the traded asset | `getService(o.marketplaceService)?.standard` |

The 2026-05-15 draft §2.3 catalogued six call sites doing `event.from_address === MARKETPLACE_1155_CONTRACT`. All collapse to a registry lookup. No address string-comparison survives anywhere in venue logic (`01 §X`, `05 §V`).

`marketplaceContract` remains a denormalized column (draft §10.1, locked) **only** for explorer links — never a behavior discriminator.

---

## V. Where the shape generalizes (don't build it yet)

`01 §V` defers the generalization decision to *the moment the first multi-item venue ships*, not before. This document records the venues that will force it and the two designs on the table — it does not pick one early (that would be a premature abstraction; memory `feedback_no_premature_constants`).

| Future venue | What it needs the Order to express |
|---|---|
| Bulk-order venue | N Assets for one price (one-to-many) |
| Auction house | ascending/declining bids over time; settlement on close |
| Coin trader | ERC-20 ↔ ERC-20 / ERC-20 ↔ asset, possibly criteria-based |

The two generalization options (`01 §V`, restated, still undecided):

- **Option A — related `OrderItem` table.** Order has many offer items and many consideration items. Mirrors SeaPort. Queryable.
- **Option B — `Order.servicePayload: Json`.** Keep the denormalized 1+1 columns for query speed; venue-specific extensions live in an opaque payload. Loses queryability on the payload.

Decision rule: **chosen when the first multi-item venue is actually designed**, evaluated against that venue's query needs — not pre-emptively. Each new venue is otherwise a registry entry plus an event parser (`02 §III Event`, `05 §VII`), zero core-schema change, exactly like asset services.

---

## VI. Adding a venue (the concrete flow)

Same shape as "adding a service" (`05`), specialized for venues:

1. Deploy the venue contract (e.g. auction house).
2. Register `medialane-auction` in the SDK service registry with marketplace capabilities + any venue-specific `metadataSchema` (e.g. min-increment, bid strategy).
3. Add an event parser for the venue's events (`AuctionCreated`, `BidPlaced`, `AuctionSettled`).
4. `Order.marketplaceService` now accepts `"medialane-auction"`. The fulfill flow resolves the venue via the registry. **No address-equality discrimination introduced anywhere.**

If and only if the venue is multi-item, the Option A/B decision (§V) is made *then*.

---

## VII. Year-1 reality

| Concern | v1 | Later |
|---|---|---|
| Venues | `medialane-marketplace-erc721`, `medialane-marketplace-erc1155` | auction, bulk-order, coin trader as registry entries |
| Order shape | 1+1 offer/consideration, fixed-price + single bid + swap | N+N decided at first multi-item venue (§V) |
| Status | 4 canonical; counter-offers via `parentOrderHash` | unchanged |
| Routing | `marketplaceService` registry lookup | unchanged; on-chain registry in year 2 (`05 §VII`) |
| Fees | platform-layer, 1% marketplace today, fuller schedule undecided (`00 §12`) | DAO-set, still platform-layer (`08`) |

The 1+1 shape is *fine for v1* (`01 §V`). The architecture must neither pretend it's more general than it is nor block the generalization.

---

## VIII. What this rules out

- **Address-equality venue discrimination.** The exact anti-pattern this model removes (`01 §X`, §IV).
- **`COUNTER_OFFERED` (or any feature value) as a core status.** Workflows are linked Orders, not lifecycle states (§III).
- **Pre-emptively choosing Option A or B.** Decided at the first multi-item venue, against its real needs (§V).
- **A venue that only the dapp can use.** Venue behavior is registry-resolved and SDK-exposed; agents and third parties route the same way (`00 §5`, `00 §6`).
- **Fees inside the venue contract.** Venue protocols are zero-fee; any fee is platform-layer (`00 §12`).
- **Treating `marketplaceContract` as behavior.** Explorer-link only (§IV).

---

## IX. Related documents

- `00-principles.md` — §5 (protocol-first), §6 (agents), §12 (fees at platform layer)
- `01-core-model.md` — §V (Order), §X (no separate marketplace primitive, no address routing)
- `02-protocol-app-split.md` — §III Order (chain vs index split), §IV (reconciliation)
- `05-service-model.md` — §V (venues are Services), the registry/capability model venues reuse
- `08-dao-governance.md` — DAO curation of venue services; the (open) fee schedule
- `2026-05-15-asset-service-model.md` — §8.1 (counter-offer cleanup), §10.1 (`marketplaceContract` decision)

---

**Next document:** `07-identity-model.md` — the Account model in depth: Wallet normalization, Account aggregation, the Creator/collector/organization/agent roles, `AccountID`, the attestation signing scheme, and how authentication relates to on-chain authorization.
