# 01 — Core Model

**Status:** Draft for review. Builds on `00-principles.md`.

---

## What this is

The irreducible primitives of the Medialane protocol. Six concepts that everything else composes from. Once these are locked, every other architecture document (`02` through `09`) describes how to project these primitives onto contracts, indexers, SDKs, and apps.

## The six primitives

1. **Asset** — a digital good on a chain
2. **Identity** — a wallet, a creator, or the bridge between them
3. **Service** — a protocol module that produces assets, venues, or both
4. **License** — the programmable rights attached to an asset
5. **Order** — a proposal to exchange assets
6. **Event** — the on-chain heartbeat that the platform indexes

Venues exist, but they are a *kind* of Service (one with marketplace capabilities), not a separate primitive. Anywhere this doc says "Service," a Venue is included.

---

## I. Asset

**Definition:** A digital good that exists on a chain. Held by an Identity. Issued by a Service (or by no Service, in which case it is "external"). Carries metadata that includes its License.

### Identity (the addressing of an Asset)

Two levels:

- **Chain-local identity** — the tuple `(chain, contractAddress, tokenId)`. Always exists. Always unique within the chain. Already in the schema today.
- **Logical identity** — the `IP-ID`. A canonical work identifier issued by the `IP-ID` contract on Starknet. One `IP-ID` may have multiple chain-local representations (e.g. the same composition exists as an ERC-721 on Starknet, an Ordinal on Bitcoin, an ERC-1155 edition on Ethereum). The `IP-ID` is what makes "this is the same work" provable across chains.

**Year-1 reality:** `IP-ID` is unfinished and will be reviewed/refactored. v1 treats `(chain, contractAddress, tokenId)` as the canonical identity. The indexer joins cross-chain representations via off-chain heuristics (creator wallet, content hash) where useful. As `IP-ID` matures, the system migrates to on-chain joins.

### Properties

| Property | Source of truth | Notes |
|---|---|---|
| `chain` | On-chain (where it lives) | Load-bearing per `00-principles §3`. |
| `contractAddress` | On-chain | The asset's contract. |
| `tokenId` | On-chain | Token within the contract. |
| `standard` | On-chain via SRC5/ERC-165 detection | `ERC721`, `ERC1155`, future `ERC20`. Describes the call surface. |
| `service` | Indexer-attributed at index time | Open-ended string, looked up in the SDK service registry. `null` for external assets. |
| `owner` (or `balances` for fungible/semi-fungible) | On-chain via `owner_of` / balance query | Authoritative. The database caches it. |
| `metadata` | Off-chain (IPFS, Arweave) referenced by on-chain `tokenURI` | Includes the License, attributes, image, etc. |
| `ipId` (future) | On-chain via `IP-ID` contract | The cross-chain work identifier. |

### Three things an Asset is not

- **Not a row in our database.** The database is a cache. If we lose it, the assets persist on-chain; we re-index.
- **Not bound to Medialane services.** External assets (anything the indexer finds on a chain we watch) are first-class. `service: null` is a valid, supported state.
- **Not the same as its representations on other chains.** Two `(chain, contract, tokenId)` tuples can share an `IP-ID` and they are the *same work* in protocol terms, but they remain separate Assets with separate ownership trails. The work is one; the assets are many.

### Year-1 reality

- The schema has separate `Collection` and `Token` tables. A `Collection` is a group of Assets sharing a contract address. A `Token` is one Asset. This split predates this document and stays — it's a useful aggregation, not a conceptual primitive.
- Asset metadata schema is OpenSea-compatible (see `03-interoperability.md`). New service-specific shapes layer on top of the OpenSea baseline, never replace it.

---

## II. Identity

**Definition:** Who is acting. The "who" exists at three scales: wallet, creator, profile. They are distinct entities; the relationships between them matter as much as the entities themselves.

### Wallet

A specific address on a specific chain. Atomic. Has a private key (or session-key control via a smart-wallet contract). Cannot be split. Cannot be merged with another wallet.

**Identity:** `(chain, address)`. Address is normalized (per chain conventions — Starknet pads to 64-char hex, Ethereum uses checksummed lowercase, Bitcoin uses bech32/base58).

A wallet is the only thing that can sign and act on-chain. Everything else in the identity model bridges to wallets.

### Creator

A logical person or organization. May own wallets across multiple chains. The same creator might have a Starknet wallet for trading IP and a Bitcoin wallet for receiving payments. To the protocol, they are one Creator.

**Identity:** A `CreatorID` issued by the future `CreatorID` contract on Starknet. v1 uses a primary wallet as the creator identifier (with off-chain linkages to secondary wallets via signed attestations).

A wallet declares it belongs to a Creator via a signed statement on a chain the Creator trusts. The protocol verifies the signature; the indexer aggregates owned wallets into one logical creator.

**Year-1 reality:** Creator identity is currently `(chain, walletAddress)` — one wallet, one creator. Cross-chain linkage is a Year-2+ project. The architecture must not block it.

### Profile

Off-chain enrichment for a Creator. Display name, bio, social handles, avatar, custom slug. Stored in `CreatorProfile` (and `CollectionProfile` for collection-level versions). Editable. Never authoritative.

The Profile is presentation layer. Losing it loses no protocol state — the wallet's history, ownership, and orders all persist.

**Why three scales:** The wallet is the only thing that can sign. The Creator is the only thing that has a reputation. The Profile is the only thing that has a face. Conflating them means the protocol can't handle a creator changing wallets, can't aggregate cross-chain reputation, and can't let users edit display info without affecting their crypto identity.

### Cross-chain identity: two distinct mechanisms

Per `00-principles §10`:

- **Asset cross-chain identity** uses `IP-ID`. The same *work* (the song, the photograph, the document) exists as multiple Assets on multiple chains; `IP-ID` is the canonical join.
- **Creator cross-chain identity** uses signed attestations. The same *person* owns wallets on multiple chains; signed link statements ("I, this Bitcoin wallet, attest I am the same creator as this Starknet wallet, at block N") form the graph.

These are different mechanisms because they answer different questions. "Is this the same artwork?" is about provenance and authorship; the work itself is a fixed thing being represented. "Is this the same person?" is about claims of equivalence; the person is the asserter.

---

## III. Service

**Definition:** A protocol module that produces Assets or matches Orders (or both). Identified by a stable string ID. Defined in the SDK service registry (year 1) and eventually on-chain (year 2+).

### Identity

`service: string` — e.g. `"mip-erc721"`, `"pop"`, `"drop"`, `"mip-erc1155"`, `"ip-erc721"` (today's five active services), plus marketplace services like `"medialane-marketplace-erc721"`.

Stable across contract upgrades. When a service's contract gets a new audit, the service ID stays the same; only the registry's pointer to the contract address updates. This is what the v3 audit incident on 2026-05-14 should have been like — single source of truth update, no cascading code changes.

### A Service definition

What lives in the service registry (TypeScript today; on-chain registry contract eventually):

```
{
  id: string                          // "pop"
  displayName: string                 // "POP Protocol"
  description: string                 // "Soulbound proof-of-presence collectibles"
  standard: TokenStandard             // "ERC721"
  provenance: "MEDIALANE" | "EXTERNAL"
  onchain?: {                         // null for non-deploying services (rare)
    factoryAddress?: string
    classHash?: string
    startBlock?: number
  }
  uiVariant: string                   // "pop" — drives dapp routing
  capabilities: ServiceCapability[]   // ["claim", "transfer", "report"]
  metadataSchema?: MetadataSchema     // attribute whitelist, license default
}
```

### Why Service is the central abstraction

Three principles converge on the Service primitive:

- `§5 protocol-first` — services are how new behavior enters the protocol. The protocol grows by adding services, not by editing existing ones.
- `§6 AI agents first-class` — agents read the service registry to discover what's available. The registry is the protocol's self-description; agents consume it like humans consume the launchpad UI.
- `§8 interoperability` — each service declares its own asset shape and metadata extensions. The OpenSea-compatible baseline is preserved; service-specific extensions layer on top.

### Capability registry

A small typed set of capabilities that any Service can declare. Examples:

| Capability | Meaning |
|---|---|
| `list` | An owner can list this asset for sale via the service's preferred venue |
| `buy` | A buyer can purchase a listed asset |
| `make_offer` | A user can post a bid on the asset |
| `cancel` | An offerer/owner can cancel an order |
| `transfer` | An owner can transfer the asset |
| `mint` | A user (per service rules) can issue new assets |
| `claim` | A user can claim an asset under service-specific conditions (e.g. POP event attendance, Drop window open) |
| `airdrop` | The service supports batch issuance to many recipients |
| `remix` | The asset can serve as parent for a derivative |
| `license` | License terms attached can be exercised through the service |

Capabilities are typed (per `§10.2` in the previous service-model doc). Services that need behavior outside the typed set are signal that the set should expand — not signal to make it free-form.

### Venues are services

A marketplace contract (the ERC-721 marketplace, the ERC-1155 marketplace, future auction house, future coin trader) is a Service with capabilities `["list", "buy", "make_offer", "cancel"]`. It does not produce assets; it matches orders involving assets. Same primitive.

This unifies routing: an Order references a `marketplaceService` (which is just a service ID). The order's settlement logic, signing scheme, and fulfillment shape are all looked up in the service registry.

---

## IV. License

**Definition:** The programmable rights governing how an Asset may be used, copied, modified, distributed, and monetized. Lives in the Asset's metadata. Travels with the Asset.

### Where it lives

In the Asset's metadata (the JSON pointed to by `tokenURI`), encoded as OpenSea-compatible attributes:

```json
{
  "name": "...",
  "description": "...",
  "image": "ipfs://...",
  "attributes": [
    { "trait_type": "License", "value": "CC BY-SA" },
    { "trait_type": "Commercial Use", "value": "Allowed" },
    { "trait_type": "Derivatives", "value": "Allowed with attribution" },
    { "trait_type": "Territory", "value": "Worldwide" },
    { "trait_type": "AI Policy", "value": "Training allowed with attribution" },
    { "trait_type": "Royalty", "value": "5%" }
  ]
}
```

Other marketplaces see the attributes as plain metadata. Medialane interprets them as a License.

### Default

**CC BY-SA — Attribution ShareAlike.** Already in production. Users can choose alternatives or customize at mint time (see `04-licensing-model.md` for the full schema). The default exists because Medialane optimizes for remixability — CC BY-SA permits remixes provided the derivative shares alike and credits the original.

### Soft enforcement is the default

Per `§9`:

- The contract does not revert when a derivative is created. The License declares the terms; the platform interprets them.
- Off-chain enforcement happens at the app and partner layers. Different jurisdictions interpret IP differently; baked-in contract policy ages badly.
- Selective on-chain enforcement exists for the cases that genuinely require it: royalty splits on resale (ERC-2981-style hooks), escrow for license negotiations, time-locked unlocks. Services that need on-chain enforcement declare it.

### License as data, not entity

A License is **not** a separate database table in the protocol's core model. It's a *view* on the Asset's metadata. The SDK exposes typed accessors:

```
const license = getLicense(asset.metadata)
// → { type: "CC BY-SA", commercial: true, derivatives: "with-attribution", ... }
```

The platform may cache parsed licenses in `Token.licenseType` etc. for query speed. Those caches are derivatives of the metadata, not authoritative state.

### Why this works

It honors three principles at once:

- `§1 on-chain truth` — the License lives in metadata, which is referenced by an on-chain `tokenURI`. The asset *carries* its License; the database doesn't *grant* it.
- `§8 interoperability` — License travels in OpenSea-compatible attributes. Other marketplaces see them. The asset is portable.
- `§9 soft enforcement` — putting policy in metadata not contracts means jurisdictions adapt without contract changes; contracts stay simple and durable.

---

## V. Order

**Definition:** A signed proposal to exchange Assets. Lives partially on-chain (signature and parameters in events / contract state) and partially in the indexer (denormalized for query speed). Settles on the chain it was posted on.

### Identity

`orderHash` (within a chain) — derived from the typed-data signing payload (SNIP-12 on Starknet). Unique. Permanent.

### Shape today

Today's Order is `(offer_item, consideration_item)`:

- One Asset (or fungible amount) being offered
- One Asset (or fungible amount) being demanded
- Time bounds (start, end)
- Offerer wallet
- Optional fulfiller (binding) or null (open offer)

This is a simpler subset of SeaPort's N+N model. It covers fixed-price NFT sales, single-NFT bids, and ERC-20-for-ERC-721 swaps. It does **not** cover:

- Bundle sales (N NFTs for one price)
- NFT-for-NFT swaps with multiple items on either side
- Criteria-based offers ("buy any from this collection at this price")
- Conditional orders ("buy if X happens")

### Future shape (don't build it yet)

When a bundle service, an auction service, or a coin trader service ships, the order shape generalizes. Two possible designs:

- **Option A:** Add a related `OrderItem` table. Order has many offer items and many consideration items. Mirrors SeaPort.
- **Option B:** Keep the single denormalized columns for query speed and add `Order.servicePayload: Json` for service-specific extensions. Loses queryability on the payload contents.

Both are defensible. Choose at the moment the first multi-item service ships, not before.

### Order references

An Order is the join of several primitives:

- `offerer` — an Identity (Wallet) signed the order
- `marketplaceService` — a Service ID. Determines signing scheme (SNIP-12 domain), fulfillment shape, cancellation semantics, and which venue contract matches the order
- `offerItem.token` and `considerationItem.token` — references to Assets (via `(chain, contractAddress, tokenId)`)
- Eventually `parentOrderHash` for counter-offer workflows

The `marketplaceService` field is the routing key. No string-comparing addresses; the service registry tells the platform everything it needs to know about how this order behaves.

### Status

Today: `ACTIVE | FULFILLED | CANCELLED | EXPIRED | COUNTER_OFFERED`.

Per the earlier audit, `COUNTER_OFFERED` is a feature-specific value crammed into the core lifecycle. It will fold into the Service model — counter-offers become a workflow expressed via linked orders (`parentOrderHash`), not a third lifecycle state. UI groups orders by `parentOrderHash` to render the thread. Status returns to the four canonical values.

### Year-1 reality

The current Order model is fine for v1. The 1+1 shape covers all today's flows. The architecture must not pretend it's more general than it is, but it also must not block the generalization when it comes.

---

## VI. Event

**Definition:** A record of an on-chain occurrence that the indexer captures and projects into platform state. The atomic unit of state change. Every other primitive's history is a stream of Events.

### Identity

`(chain, txHash, logIndex)`. Always unique. Always durable. Always re-readable from chain.

### Why Event is a primitive

The platform is a shell over on-chain truth (`§1`). The way truth propagates from chain to platform is through Events. The indexer is, fundamentally, an event reducer:

```
Events on chain → Indexer pulls → Parser interprets → Handler updates DB → API serves
```

This means:

- Every protocol-level state change is observable on-chain
- The database is always reproducible from Events
- Reconciliation (verifying DB matches chain) is well-defined: replay the Events
- New services don't introduce new state shapes invisibly — they emit events the indexer learns to parse

### Event types

Each Service defines its own event shapes. Examples:

- `mip-erc721`: `CollectionCreated`, `TokenMinted`, `TokenArchived`, `TokenTransferred`, `CollectionOwnershipTransferred`
- `pop`: `EventCreated`, `Claimed`, `AllowlistUpdated`
- `drop`: `DropDeployed`, `ConditionsUpdated`, `Claimed`, `PaymentsWithdrawn`
- `medialane-marketplace-erc721`: `OrderCreated`, `OrderFulfilled`, `OrderCancelled`
- `medialane-marketplace-erc1155`: same names, different parameter encoding

The indexer maintains a registry of `(serviceId, eventName) → parser` to decode each event into a typed `ParsedEvent`. Adding a service = adding its parser table.

### Year-1 reality

The current backend has hand-coded parsers for each service's events. This works at the 5-service scale. As services grow toward 25, the parser table should be data-driven (parsers declared in the Service definition, loaded by the indexer) rather than hand-maintained. Memory: backend's `decodeCollectionCreatedEvent` helper pattern is the seed for this — extract the event layout into one place, callers use the abstraction.

---

## VII. How the primitives compose

```
                          ┌──────────────┐
                          │   Identity   │ (Wallet, Creator, Profile)
                          └──────┬───────┘
                                 │
                  owns / signs   │
                                 ▼
┌──────────────┐    deploys    ┌─────────┐    carries     ┌─────────┐
│   Service    │ ────────────► │  Asset  │ ─────────────► │ License │
└──────┬───────┘               └────┬────┘                └─────────┘
       │                            │
       │  marketplace               │  offered / demanded
       │  services match            │  in
       │                            ▼
       │                       ┌─────────┐
       └─────────────────────► │  Order  │
                               └────┬────┘
                                    │
                                    │  every state change is an
                                    ▼
                              ┌─────────┐
                              │  Event  │ ← indexed from chain
                              └─────────┘
```

Reading the diagram:

- **Service** is the only thing that creates an Asset (services that issue) or processes an Order (services that match — i.e. marketplace venues).
- **Asset** carries its **License** in metadata. The License is not a separate join; it's a view on the Asset.
- **Identity** owns Assets and signs Orders. A Wallet does the signing; the Creator is the aggregate; the Profile is the face.
- **Order** is a proposal between Identities, referencing Assets, routed through a marketplace Service.
- **Event** is the on-chain heartbeat. Every change to anything above is an Event. The indexer is the reducer.

Six primitives. One diagram. Every Medialane feature, current and future, composes from these.

---

## VIII. What this enables (concrete examples)

**Adding a new asset service (e.g. IP-Tickets):**
1. Deploy the IP-Tickets factory contract
2. Add `"ticket"` to the SDK service registry with `standard: "ERC721"`, `uiVariant: "ticket"`, capabilities `["mint", "claim", "transfer", "redeem"]`
3. Add an event parser for `TicketIssued` and `TicketRedeemed`
4. Backend indexer learns the new events. No schema migration.
5. Dapp's asset page dispatcher sees `service: "ticket"` → renders the ticket variant.

**Adding a new marketplace venue (e.g. auction house):**
1. Deploy the auction contract
2. Add `"medialane-auction"` to the SDK service registry with marketplace capabilities + auction-specific extensions (bidding strategy, minimum increment)
3. Add an event parser for `AuctionCreated`, `BidPlaced`, `AuctionSettled`
4. Order's `marketplaceService` field now accepts `"medialane-auction"`. The fulfill flow looks up the service definition. No address-equality discrimination anywhere.

**Adding a new chain (e.g. Ethereum L1):**
1. Add an indexer worker for Ethereum, with appropriate RPC + event parsing per service definition's per-chain coordinates
2. Address normalization for Ethereum addresses already exists conceptually; needs the actual implementation
3. Assets indexed from Ethereum get `chain: ETHEREUM` and the same `service` discrimination as Starknet
4. Cross-chain joins (when `IP-ID` is ready) link Starknet representations to Ethereum representations

**Cross-chain creator reputation:**
1. Creator signs an attestation from their Bitcoin wallet stating their Starknet wallet is also theirs
2. Attestation is stored (eventually on-chain, today off-chain) and verified
3. The indexer's profile aggregator joins Assets and Orders from both wallets under the same Creator
4. Reputation, sales history, and XP rewards aggregate across the linked wallets

---

## IX. Year-1 boundaries

What the v1 implementation will and won't have:

| Primitive | v1 has | v1 doesn't have (yet) |
|---|---|---|
| Asset | `(chain, contract, tokenId)` identity, OpenSea metadata baseline | `IP-ID` cross-chain joins (Year 2+) |
| Identity | Wallet identity per chain, Profile per wallet | Cross-chain wallet linkage, on-chain `CreatorID` (Year 2+) |
| Service | SDK service registry, 5 active services + 2 marketplace venues | On-chain service registry, permissionless service registration (Year 2+) |
| License | CC BY-SA default, metadata-encoded attributes, soft enforcement | Selective on-chain enforcement per service (per-service when needed) |
| Order | 1+1 offer/consideration shape, current 5 statuses, marketplaceContract address | N+N order items, criteria orders, generalized status model |
| Event | Hand-coded parsers per service | Data-driven parser registry (when service count warrants) |

The architecture supports all of the Year-2+ items. The implementation arrives in stages. Nothing in v1 paints us into a corner.

---

## X. What this rules out (cross-cutting)

A check against `00-principles.md` — designs that look reasonable but conflict with this model:

- **A separate "marketplace" primitive distinct from Service.** Marketplaces are Services with marketplace capabilities. Adding a separate primitive would fork the registry, fork the routing logic, and force every cross-cutting feature (rate limiting, capability checks, agent integration) to know about both. Same primitive, different capabilities.

- **License as a database entity with foreign keys to Asset.** The License lives in the Asset's metadata. It is the Asset's data, not a related row. Joining a license to an asset by FK introduces drift between database state and metadata state — exactly the kind of soft state that `§1 on-chain truth` rules out.

- **Identity as `wallet = creator = profile` collapsed into one row.** The three scales are separate because they answer separate questions and have separate failure modes. Conflating them blocks cross-chain identity, blocks creator wallet rotation, and ties cosmetic profile edits to authoritative crypto identity.

- **Orders that bind to `marketplaceContract` address instead of `marketplaceService`.** Same reason as the service model audit — address discrimination forces N-way string comparisons every time a new venue ships. The service registry is the indirection.

- **Asset identity that ignores `chain`.** v1 is Starknet-only; the schema and code must still treat chain as load-bearing. Any code that omits `chain` from an asset reference is a year-2-blocker waiting to happen.

---

## XI. Open design questions deferred to specific documents

- **License extension schema** (full attribute taxonomy beyond CC BY-SA) → `04-licensing-model.md`
- **Order generalization decision** (Option A vs Option B above) → made at the moment a multi-item service ships, not pre-emptively
- **Capability set evolution** (when to add a new capability vs decompose an existing one) → `05-service-model.md`
- **Creator attestation signing scheme** (SIWS variants, chain-of-trust rules) → `07-identity-model.md`
- **Event parser registry shape** (when to move from hand-coded to data-driven) → not v1; surfaces in the operational doc when service count warrants

---

## XII. Related documents

- `00-principles.md` — the axioms this model is constrained by
- `02-protocol-app-split.md` — where each primitive lives in the stack (on-chain vs indexer vs SDK vs apps)
- `03-interoperability.md` — OpenSea metadata baseline + Medialane attribute extensions (the License's encoding)
- `04-licensing-model.md` — License attribute taxonomy, customization flow, selective on-chain enforcement
- `05-service-model.md` — the Service primitive in detail, including the existing service-model draft rescoped
- `06-venue-model.md` — marketplace venues as Services with marketplace capabilities
- `07-identity-model.md` — Wallet, Creator, Profile, `IP-ID`, `CreatorID`, attestations
- `08-dao-governance.md` — how the DAO governs the service registry and protocol fees
- `09-roadmap.md` — phased rollout

---

**Next document:** `02-protocol-app-split.md` — for each primitive in this model, what lives on-chain vs in the indexer vs in the SDK vs in the apps. The contract-as-truth principle made concrete.
