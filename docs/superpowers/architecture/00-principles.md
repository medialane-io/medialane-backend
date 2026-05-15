# 00 — Architectural Principles

**Status:** Draft for review. Foundation for the rest of the architecture documents.
**Authority:** This document captures load-bearing principles. Where it conflicts with the [Integrity Web Axioms](https://www.integrityweb.xyz/axioms), the axioms govern.

---

## What this is

The load-bearing axioms that constrain every design choice at Medialane. Other architecture documents reference this one. When two design considerations conflict, the principle wins.

This is not a coding style guide. It's about architectural decisions — what gets stored where, what's gated by what, what's discoverable to whom.

## Scope

Applies to the full Medialane protocol stack: on-chain contracts (`mediolano-contracts`), the indexer (`medialane-backend`), the SDK (`medialane-sdk`), and reference apps (`medialane-dapp`, `medialane-io`). Constrains how new services, features, and integrations are designed.

---

## I. Foundations

### 1. The smart contract is the only truth

Medialane is a shell over on-chain state. The indexer and database are caches for discovery, search, and aggregation. The frontend renders a view of on-chain reality. Authority lives in the contract.

**Rules out:**
- Gating user actions (trades, transfers, mints) on database state
- "Soft state" that exists only off-chain and cannot be rebuilt from chain events
- Centralized moderation that contradicts on-chain state

**Why:** Two P0 incidents on 2026-05-15 (a wallet-type gate, an `is_transferable_token` gate) both violated this. The marketplace contract is the only authority on whether a trade can happen. If the contract accepts the call, the user can make it. Memory: `feedback_medialane_values.md`.

### 2. Permissionless

Anyone can use Medialane without asking. Anyone can deploy a contract that integrates with the protocol. Anyone can index. Anyone can build a competing client.

**Rules out:**
- Allowlists for who can create collections, mint, list, buy
- Approval workflows for legitimate trading actions
- Hardcoded curation of which contracts the indexer respects

**Year-1 reality:** the service registry (which protocols the *official* dapp surfaces in its UI) is curated by the DAO during year 1. This is a UI curation choice, not a protocol gate — third parties can index and use any contract; they just don't appear in dapp.medialane.io's launchpad without DAO blessing. Year 2+ moves toward an on-chain service registry anyone can write to.

### 3. Censorship-resistant via chain diversification

Censorship-resistance is a property of the base layer. Bitcoin is the gold standard. Starknet is permissionless but its sequencer is currently centralized. Ethereum has MEV / OFAC pressure. Solana has had pauses. No single chain is fully censorship-resistant.

Medialane's strategy: be on multiple chains, with Bitcoin as the gravity well. If one chain shuts down, censors, or fails, creators' work and identity persist on others.

**Rules out:**
- Treating `Chain` as a future/optional dimension. It is load-bearing from day one.
- Code that hardcodes Starknet conventions (address format, RPC, signing) in core logic
- Asset identity bound to a single chain

**Implementation reality:** v1 ships Starknet-only. The architecture is multichain from day one; the implementation arrives in stages:
1. Starknet (live)
2. BTC as payment currency — wBTC already accepted on the marketplace
3. Asset issuance on Bitcoin via Ordinals / Runes / Bitcoin L2s
4. Bitcoin-anchored license registry (proof of existence on the most durable chain)
5. Ethereum L1 reach, other L2s as warranted

The path is multi-year. The architecture must not preclude it.

### 4. Quantum-proof base layer

Starknet's STARK-based cryptography is post-quantum secure. As quantum computing matures, ECDSA-secured chains face theoretical risk. STARKs do not.

This is why Starknet is Medialane's primary chain even though Bitcoin has stronger censorship-resistance today. Combined with multichain reach (§3), the protocol gets quantum-resistance at its primary base layer and censorship-resistance across the broader chain set.

**Implication:** Medialane invests in Starknet-specific capabilities (verifiable off-chain computation — §7) while keeping the *asset layer* portable to chains with weaker crypto. If quantum advances compromise ECDSA, the protocol's identity, attestations, and proof systems on Starknet survive; assets on other chains can be re-attested on Starknet.

---

## II. Architecture posture

### 5. Protocol-first, apps as clients

Long-term, Medialane is a protocol — a set of contracts plus the SDK that exposes them. The dapp and io are reference clients. Partners and AI agents are first-class consumers. The DAO governs the protocol.

**The protocol is a public good. The apps are tools that consume the public good.**

**Rules out:**
- Features that only work in dapp.medialane.io (the SDK must expose everything the dapp does)
- Lock-in patterns where assets are unusable outside Medialane's apps
- Closed-source SDK or API gating that prevents partner / agent integration

**Implication:** Every dapp feature has an SDK equivalent. Every SDK feature is accessible via the public API. The reference apps are the canonical demonstration of the protocol, not the only path to use it.

### 6. AI agents are first-class users from day one

Agents consume Medialane the same way humans do: via the SDK and the public API. They have wallets, sign typed data, list and buy. The architecture treats agent-driven flows the same as human-driven flows — with one caveat: agents transact at higher volume, so capability-scoped API keys and per-agent rate limits exist for operational reasons (not as gates on permission).

**Rules out:**
- "Human-only" UI flows that require interactive elements no agent can replicate
- CAPTCHA / anti-bot measures on legitimate agent activity
- Different fee schedules for agents vs humans
- Behavior that depends on browser-only signals (mouse movement, time-on-page)

**Specific commitments:**
- The SDK service registry is the *primary* interface; the dapp UI is a view on top of it. Agents reading the registry see the same services humans do.
- Action descriptions in capability registries are agent-readable (structured JSON, not human-only docs)
- Rate limits scale with operational need, not user category

**Why:** Cultural commerce in the AI era assumes agents trading on behalf of humans, agents trading on behalf of agents, and humans trading among each other. The platform that natively supports all three wins.

### 7. Verifiable computation is a Medialane capability

Starknet's STARK proofs let Medialane attest to off-chain facts on-chain. A music composition's value depends on its play count; Medialane can prove "this composition was played N times on Spotify last month" without trusting Spotify, by running verification off-chain and posting a STARK proof. The IP gets richer as the proofs accumulate.

This is unique to Starknet today. Ethereum has SNARK-based ZK rollups but not native STARK computation; Bitcoin has no native ZK. The capability lives on Starknet; the assets it enriches can live on any chain.

**Implication for service design:** Services that depend on real-world data (play counts, sales figures, audience metrics, time-stamped events) integrate with a Medialane-provided proof layer rather than oracle-style trust models. **Year-1 doesn't ship this**; it's the differentiator that compounds as the protocol matures.

**Example use cases (future, not v1):**
- Music: prove streaming counts → license value
- Photography: prove publication in named outlets → reputation
- Software: prove install/usage counts → maintenance grants
- Video: prove view counts on referenced platforms → ad-share-style royalties

---

## III. Asset + interoperability strategy

### 8. Assets are interoperable via standards

Medialane-deployed assets follow OpenSea ERC-721 / ERC-1155 metadata standards. They appear on third-party marketplaces. They travel with the creator if Medialane disappears.

Medialane's differentiation lives in the **platform layer** — gated content, on-chain comments, licensing UX, capital markets venues, verifiable proofs, AI agent integration. Not in vendor-locking the assets.

**Rules out:**
- Custom metadata formats that only Medialane can read
- Contract behaviors that trap assets in Medialane (mandatory royalty hooks that fail on third-party marketplaces, non-transferable by default, etc.)
- Soulbound assets *except* where the specific service requires it (e.g., POP Protocol attendance proofs)

**Implication:** A creator can list their Medialane-minted asset on OpenSea, Element, X2Y2. Medialane's marketplace is the best place to trade it (lowest fees, best UX, on-chain comments visible, verifiable proofs attached) but not the only place. Interoperability is a moat, not a constraint.

### 9. Licensing in metadata, soft-enforced by default

Programmable IP licenses are encoded in asset metadata via OpenSea-compatible attributes. They are *not* enforced by default at the contract level. The platform layer (apps, partners) interprets and enforces selectively per jurisdiction.

**Default license:** CC BY-SA — Attribution ShareAlike. Already in production. Users can choose or customize on mint.

**Rules out:**
- Contracts that revert if a derivative is created without paying royalties (specific services may opt in; the default does not)
- Platform UI that pretends licensing is enforced on-chain when it isn't
- Single global license terms that ignore jurisdictional diversity

**Why:** IP law varies wildly across jurisdictions. Hardcoding compliance into contracts ages badly — contracts are immutable; laws change. Hardcoded enforcement also fragments by jurisdiction (a contract that enforces US fair-use will fail in EU GDPR territory, and vice versa). Soft enforcement at the app/partner layer lets Medialane and integrators adapt while keeping contracts simple and durable.

**On-chain enforcement is selective.** Services that genuinely need it (royalty splits on resale, escrow for negotiations, time-locked unlocks) bake enforcement into their specific contract. Default service contracts do not.

### 10. Cross-chain identity at the protocol level

A creator's "work" is a logical identity. Each chain hosts a representation (ERC-721 on Starknet, Ordinal on Bitcoin, ERC-1155 edition on Ethereum). The protocol provides a canonical work identifier (`IP-ID` contract on Starknet) that representations reference.

Similarly for creator identity: a single creator may hold wallets across multiple chains. The protocol links them via signed attestations; the platform aggregates reputation, work, and sales across the linked set.

**Rules out:**
- Asset identity that assumes one `(chain, contract, tokenId)` tuple is the canonical identifier
- Profile / reputation systems that fragment per chain
- Trust assumptions that one wallet = one creator

**Year-1 reality:** `IP-ID` is unfinished and will be reviewed/refactored. v1 uses `(chain, contract, tokenId)` as identity, with the indexer doing cross-chain joins via off-chain heuristics. As `IP-ID` matures, the system migrates to on-chain joins. Both for assets and for creators.

---

## IV. Values

### 11. Integrity web, not financialization

Medialane optimizes for creator agency and cultural durability — not investor extraction. Reward systems incentivize action (creating, trading, engaging), not volume (wash trading is structurally pointless). Discovery prioritizes creators, not whales.

**Rules out:**
- Leverage, liquidations, perpetual futures, or other primarily-speculative trading primitives on cultural assets
- Discovery surfaces that rank by trading volume alone
- Reward systems that pay proportionally to spend (creates wash-trade incentive)

**Already in code:** The XP reward system in medialane-backend is action-based, with daily caps and multipliers — designed to resist wash trading by construction. (Memory: backend `CLAUDE.md` "anti-gaming" note.)

### 12. DAO-stewarded, public-goods-aligned

The Medialane DAO is the protocol's steward. Governance via [Snapshot](https://snapshot.org/#/s:medialane.eth) with the MDLN token (Ethereum, Starknet bridge). Public site: [medialane.org](https://www.medialane.org).

**Year-1 responsibilities:**
- Owns and operates the contracts
- Receives protocol fees (1% on marketplace today)
- Curates the service registry (which protocols appear in the official dapp launchpad)
- Decides parameter changes (fee tiers, featured collections, treasury allocations)

**Year-2+ progressive decentralization:**
- On-chain service registry (anyone can write; UI surfaces are reputation-ranked)
- Fee allocation governed by token holders
- Treasury management decentralized
- Protocol upgrades (where applicable) routed through governance

**Rules out:**
- Platform-team unilateral decisions on what's in the official service registry once year 1 ends
- Centralized treasury that can be seized
- Closed governance that excludes MDLN holders

---

## V. Non-goals (what we won't do)

In addition to what each principle above rules out, an explicit non-goal list:

- **Not a curated marketplace.** Medialane lists every asset the indexer finds, not a hand-picked roster. Discovery surfaces help users find what they want; curation is opt-in (claimed collections, featured drops) and never a gate.
- **Not a single-chain platform.** Even if v1 is Starknet-only in practice, the architecture never treats single-chain as the default assumption.
- **Not a financialization platform first.** "Creators capital markets" means giving creators access to liquidity for their IP, not optimizing for trader yield extraction.
- **Not a closed integration story.** Partners, AI agents, third-party clients can integrate as deeply as our own dapp. No private APIs, no gating-via-deprecation.
- **Not policy-baked-into-contracts.** Jurisdictional rules vary. Contracts stay neutral; platforms enforce selectively.
- **Not the only enforcement layer.** Other clients of the protocol implement their own policies. Medialane's apps enforce Medialane's house rules. The protocol below them is the public good.
- **Not a place for premature abstractions.** Three similar lines is better than a forced abstraction. Memory: `feedback_no_premature_constants.md`.

---

## VI. How to use this document

When designing a new service, schema change, or feature, walk through the principles. If a design conflicts with one of them, either:

1. **Change the design** until it complies, or
2. **Argue that the principle should change** — and update this document with the new consensus, dated and DAO-blessed

A design that violates a principle without amending the document is, by definition, a regression. The principles are the contract between the platform team, the DAO, and the protocol's users.

---

## VII. Related documents (planned, in dependency order)

- **00** — Architectural Principles (this document)
- **01** — `core-model.md` — Asset, Service, License, Identity, Order, Venue, Event primitives
- **02** — `protocol-app-split.md` — What lives on-chain vs indexer vs SDK vs apps
- **03** — `interoperability.md` — OpenSea metadata baseline + Medialane attribute extensions
- **04** — `licensing-model.md` — Programmable licensing in detail (CC BY-SA default, customization, selective on-chain enforcement)
- **05** — `service-model.md` — The asset/service model (rescoped from the 2026-05-15 draft)
- **06** — `venue-model.md` — Marketplace venues as composable surfaces (bulk orders, auctions, future coin trader)
- **07** — `identity-model.md` — Wallets, profiles, `IP-ID`, cross-chain identity
- **08** — `dao-governance.md` — DAO role, fees, registry curation, decentralization roadmap
- **09** — `roadmap.md` — Phased rollout, year-1 milestones, year-2 targets, year-3+ horizon

Each document is short, principle-grounded, and evolvable independently. Implementation plans for code work follow each architecture document, not the other way around.

---

## VIII. Open questions deferred to specific documents

- Bitcoin path ordering (payment vs Ordinal issuance vs license anchoring) — `09-roadmap.md`
- `IP-ID` exact shape — `07-identity-model.md`
- Cross-chain wallet attestation format — `07-identity-model.md`
- Capability registry typing (open-ended string vs typed enum) — `05-service-model.md`
- Verifiable computation integration points — own document when v2 work begins, not v1 concern

Anything not listed here that conflicts with a principle is governed by §VI — change the design, not the principle, unless DAO consensus says otherwise.

---

**Next document:** `01-core-model.md` — what the irreducible primitives are and how they relate. Lock principles first; the rest of the docs build on this foundation.
