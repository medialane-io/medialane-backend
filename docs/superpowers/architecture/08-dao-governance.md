# 08 — DAO Governance

**Status:** Draft for review. Builds on `00-principles.md` (§2 permissionless, §11 integrity-not-financialization, §12 fees, §13 Mediolano substrate).

---

## What this is

The Medialane DAO's role: what it owns, what it decides, the (still-open, platform-layer) fee schedule, service-registry curation, the progressive-decentralization arc, and — critically — where **Mediolano's independence** sits relative to Medialane governance.

Governing principle (`00 §2`, `00 §12`): **the DAO governs Medialane's commercial layer, not the protocol's permissionlessness. Curation is a UI choice, never a protocol gate. Fees are a platform-layer decision the DAO makes, never contract-baked.**

---

## I. The steward

The Medialane DAO is the protocol's steward. Governance via [Snapshot](https://snapshot.org/#/s:medialane.eth) with the **MDLN** token (Ethereum, with a Starknet bridge). Public site: [medialane.org](https://www.medialane.org).

The DAO stewards Medialane. It does **not** govern Mediolano (§V) and it does **not** hold authority over what users may do on-chain (`00 §1`, `00 §2`) — the contracts do that. Its scope is the commercial layer: which services the *official* apps surface, the fee schedule, treasury, and parameter changes.

---

## II. Year-1 responsibilities

| Responsibility | Detail |
|---|---|
| Owns + operates the contracts | Deploys, holds admin keys where contracts have them |
| Sets the fee schedule | Platform-layer, **still open** (§III) |
| Curates the service registry | Which services appear in the official dapp launchpad (`05`) |
| Decides parameters | Fee tiers, featured collections, treasury allocations, reward-system config (`00 §11`) |

**Curation is UI curation, not a protocol gate** (`00 §2` year-1 reality). The DAO choosing which services the official launchpad *surfaces* does not stop anyone indexing or using any contract. Third parties run their own clients against the same permissionless protocol. medialane.io is governed by the DAO and its community; the protocol underneath is not.

---

## III. The fee schedule (a DAO decision, platform-layer, still open)

Per `00 §12` — restated because it is the most-violated point:

- The marketplace and Launchpad **protocols are zero-fee**. No fee logic in the immutable contracts. (Mediolano, the substrate, is likewise zero-fee — §V.)
- Any fee is applied at the **platform layer** (settlement / SDK / app), where the DAO can change it without a contract migration and where third-party clients are not forced to pay it (`00 §5`).
- **Today:** a 1% fee on marketplace activity, platform-layer. The fuller model (a Launchpad service fee on revenue products; auction/remix/licensing fees) is **not yet decided**. When the DAO decides it, it lands at the platform layer, never in a contract.
- Whatever the schedule becomes: it accrues to the DAO treasury, funds the protocol as a public good (not extraction — `00 §11`), applies equally across user categories (no agent-vs-human split — `00 §6`), and never becomes a second *gate* (`00 §11`).

This document does not pre-decide the schedule. It records that **deciding it is a DAO governance action**, bounded by the constraints above.

---

## IV. The progressive-decentralization arc

`00 §2`, `00 §12`, `05 §VII`, `07 §IV` all point at the same year-2+ trajectory. Consolidated:

| Domain | Year 1 | Year 2+ |
|---|---|---|
| Service registry | DAO-curated, SDK-resident (`05 §VII`) | On-chain registry, **permissionless writes**; official-UI surfaces reputation-ranked |
| Fee allocation | DAO sets + receives | Token-holder-governed allocation; still platform-layer |
| Treasury | DAO multisig/treasury | Decentralized treasury management |
| Account / asset joins | off-chain heuristics (`07 §IV`, `01 §I`) | on-chain `AccountID` / `IP-ID` |
| Protocol upgrades | DAO (where contracts are upgradeable) | routed through governance |

The arc is one-directional: toward less platform-team discretion, more on-chain permissionlessness. Year-1 centralization is a declared, dated bootstrap (`05 §VII`, `07 §VI`), not a destination.

---

## V. Mediolano is independent of this governance

The load-bearing boundary, from `00 §13`:

- **Mediolano is a separate, independent entity.** It predates Medialane and functions as a zero-fee, Berne-aligned public good for IP tokenization and protection. It is **not** governed by the Medialane DAO.
- **The separation is a compliance feature, not an org-chart accident.** Mediolano stays a neutral, fee-free, treaty-aligned ownership substrate; Medialane carries the commercial surface and house rules. Coupling Mediolano's governance to Medialane's would jeopardize exactly the legal durability the separation buys (`00 §13`).
- **What this means for governance proposals:** a Medialane DAO vote can change Medialane's fee schedule, registry curation, treasury — it cannot impose fees on, gate, or otherwise govern Mediolano's primitives. Any proposal that does is out of scope by construction.

---

## VI. What this rules out

- **Platform-team unilateral decisions post year-1.** Once the bootstrap ends, registry/fee/treasury decisions route through governance, not the team (`00 §12`).
- **A centralized, seizable treasury.** The year-2 arc decentralizes it (§IV).
- **Closed governance.** MDLN holders are not excludable from decisions in scope.
- **Fees baked into contracts.** A DAO fee decision is platform-layer; putting it in an immutable contract violates `00 §12` and freezes a governance lever.
- **Curation presented as a protocol gate.** The official launchpad is a view; the protocol is open to all clients (`00 §2`, §II).
- **Governing Mediolano via the Medialane DAO.** Out of scope by construction; the independence is a compliance invariant (§V).
- **A governance action that gates protocol actions.** The DAO stewards the commercial layer; it never overrides `00 §1`.

---

## VII. Open questions deferred

- **Exact fee schedule** — a future DAO governance action, bounded by §III. Not pre-decided here.
- **On-chain registry write-permission model** — the year-2 registry contract's spam/reputation design. Surfaces in a year-2 doc, not v1.
- **Treasury decentralization mechanism** — multisig → on-chain governance migration path. Year-2+ scope.

---

## VIII. Related documents

- `00-principles.md` — §2 (permissionless, year-1 curation carve-out), §11 (integrity, not extraction), §12 (fees at platform layer), §13 (Mediolano substrate)
- `05-service-model.md` — §VII (registry decentralization arc the DAO drives)
- `07-identity-model.md` — §IV/§VI (year-2 on-chain `AccountID`)
- `09-roadmap.md` — the phased timeline these year-1/year-2 splits live on

---

**Next document:** `09-roadmap.md` — the phased rollout that ties every "Year-1 reality" table across `01`–`08` to a timeline: v1 scope, year-1 milestones, year-2 targets (multichain, on-chain registries, enforcement services), year-3+ horizon (verifiable computation, full decentralization).
