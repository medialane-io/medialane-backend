# 09 — Roadmap

**Status:** Draft for review. Synthesizes the "Year-1 reality" sections of `01`–`08` into one timeline. Builds on `00-principles.md` (§3 chain diversification, §7 verifiable computation, §2/§12 decentralization & fees).

---

## What this is

The phased rollout. Every other document declares a v1 scope and a "supports later, doesn't block it" boundary. This document is the single place those boundaries are sequenced into a timeline — so a reader can see *when* each deferred thing lands and *in what order*.

Governing principle (every doc's "Year-1 reality"): **v1 ships the smallest correct foundation; nothing in v1 paints the protocol into a corner. The roadmap is staged so each phase ships value before the next begins.**

This is a horizon, not a contract. Dates are sequence, not commitment.

---

## I. Now — v1 (pre-launch)

The immediate goal: finish the first version and bring creators on board (2026-05-15 draft §0). Not pre-building for 25 services — a clean foundation that won't compound debt.

| Domain | v1 state | Source |
|---|---|---|
| Chain | Starknet-only in practice; architecture multichain from day one | `00 §3` |
| Assets | `(chain,contract,tokenId)`; OpenSea metadata baseline | `01 §I`, `03` |
| Accounts | primary Wallet = Account; one Wallet, one Account; roles as attributes | `01 §II`, `07` |
| Services | SDK registry, 5 active services + 2 marketplace venues | `05 §VI` |
| Licensing | CC BY-SA default; metadata-encoded; soft enforcement everywhere | `04` |
| Orders | 1+1 offer/consideration; 4 canonical statuses | `01 §V`, `06` |
| Fees | 1% marketplace, platform-layer; fuller schedule undecided | `00 §12`, `08 §III` |
| Indexer | hand-coded per-service parsers; single Starknet worker | `02 §V` |

In-flight v1 engineering (architecture is settled; implementation follows):
- The service-model refactor — drop `CollectionSource`, add `service`/`marketplaceService`, SDK registry (`05`; impl plan in the 2026-05-15 draft §5/§11).
- The Account taxonomy — `Account`/role split, `AccountProfile`/`CreatorProfile` (`01 §II`, `07`).

---

## II. Year 1 — milestones

Within the first year of operation:

1. **Ship v1 + creator onboarding.** The whole point.
2. **Service-model refactor landed in production** — registry-driven routing; zero-migration service additions proven by adding at least one parking-lot service (`05 §VI`).
3. **BTC as payment currency** — wBTC already accepted on the marketplace (`00 §3` step 2); formalize and surface it.
4. **Fee-schedule decision** — the DAO decides the fuller platform-layer schedule within `00 §12` constraints (`08 §III`). Still platform-layer, still zero-fee contracts.
5. **DAO bootstrap operating** — Snapshot governance live, registry curation as a DAO function, reward-system config DAO-managed (`08 §II`, `00 §11`).

Boundary: everything here is additive on the v1 foundation. No primitive changes.

---

## III. Year 2 — targets

The "supports later" column of every doc, made concrete:

| Target | What it unblocks | Source |
|---|---|---|
| On-chain service registry, permissionless writes | Anyone registers a service; official UI reputation-ranked | `05 §VII`, `08 §IV` |
| `AccountID` contract + cross-chain Wallet linkage | One actor, many chains; aggregated reputation | `07 §IV` |
| `IP-ID` on-chain joins | One work, many chain representations, provable | `01 §I` |
| Asset issuance on Bitcoin | `00 §3` step 3 — work persists on the most durable chain | `00 §3` |
| Data-driven event-parser registry | Parser declared in the service definition, not hand-coded | `02 §V` |
| Opt-in enforcement services | Escrow / time-lock / revocable / royalty-split venues that *declare* enforcement | `04 §V`, `05 §IV` |
| Order generalization (Option A or B) | N+N orders — *decided when the first multi-item venue ships*, not before | `01 §V`, `06 §V` |
| Fee allocation token-governed | Decentralized treasury direction | `08 §IV` |

Multichain ordering (the `00 §VIII` open question, sequenced here):

```
1. Starknet                       (live)
2. BTC as payment (wBTC)          (Year 1)
3. Asset issuance on Bitcoin      (Year 2)
4. Bitcoin-anchored license registry  (Year 2→3)
5. Ethereum L1 / other L2s        (as warranted)
```

This ordering is the resolution of the deferred question in `00 §VIII`; later docs treat it as settled.

---

## IV. Year 3+ — horizon

Compounding differentiators, explicitly *not* v1 concerns:

- **Verifiable computation** (`00 §7`) — STARK-proven off-chain facts (play counts, sales figures, audience metrics) enriching IP value without oracle-style trust. The differentiator that compounds as the protocol matures; integrated as a Medialane-provided proof layer, not retrofitted.
- **Bitcoin-anchored license registry** (`00 §3` step 4) — proof-of-existence on the most censorship-resistant chain; Berne durability at its strongest (`00 §13`).
- **Full progressive decentralization** (`08 §IV`) — registry, fees, treasury, upgrades routed through governance; platform-team discretion approaching zero.
- **Creator capital markets at maturity** (`00 §11`) — liquidity for IP without financialization-first extraction; the Launchpad/Marketplace two-hub model (`01` intro) operating at scale.

---

## V. The invariant across all phases

Each phase is gated by one test, repeated in every doc's "Year-1 reality": **does the v1 implementation make the later phase unreachable?** If yes, the v1 design is wrong and changes now. If no, v1 ships lean and the later phase is additive.

Concretely, nothing in v1 may:
- bake a single chain's conventions into core logic (`00 §3`) — blocks the multichain arc
- enumerate services/venues in the schema (`05 §I`, `06`) — blocks permissionless registration
- collapse `wallet=account=profile` (`07 §VII`) — blocks cross-chain identity
- put fees in contracts (`00 §12`) — freezes the governance lever
- gate protocol actions on platform state (`00 §1`) — the cardinal violation

The roadmap works only because the foundation refuses these five.

---

## VI. What this rules out

- **Treating dates as commitments.** This is sequence and dependency order; scope per phase is fixed, timing is not.
- **Pulling a year-2 target into v1 "while we're here."** Each phase ships value before the next; premature build is the debt this roadmap avoids (`feedback_no_premature_constants`).
- **Shipping a v1 shortcut that fails §V's test.** A corner-painting shortcut is rejected at design time, not deferred to a "later refactor."
- **Re-opening settled sequencing.** The multichain ordering (§III) resolves `00 §VIII`; downstream docs rely on it.

---

## VII. Related documents

- `00-principles.md` — §3 (chain diversification path), §7 (verifiable computation horizon), §VIII (the ordering this doc resolves)
- `01`–`08` — every "Year-1 reality" section feeds the §I/§III tables here
- `02-protocol-app-split.md` — §V (indexer scaling arc)
- `05-service-model.md` — §VII (registry decentralization), the 2026-05-15 draft's implementation/phase plan
- `08-dao-governance.md` — §IV (the decentralization arc this timeline carries)

---

**End of the numbered architecture series (`00`–`09`).** Implementation plans for code work follow each architecture document — never the reverse. The next artifacts are *implementation plans* (the 2026-05-15 draft §11 is the template), not further architecture docs, unless a principle itself changes (`00 §VI` — change the design, or amend the principle with DAO consensus, dated).
