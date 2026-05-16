# 07 — Identity Model

**Status:** Draft for review. Builds on `00-principles.md` (§1 contract is truth, §3 chain diversification, §6 agents), `01-core-model.md` (§II Account), `02-protocol-app-split.md` (§III Account — what's legitimately platform-layer).

---

## What this is

The Account model in depth: Wallet, Account, Profile; the Creator/collector/organization/agent roles; the `AccountID` contract; the attestation signing scheme for cross-chain linkage; and the line between **authentication** (who is asking) and **authorization** (what the chain permits).

`01 §II` introduced the three facets and the Account-is-the-primitive / Creator-is-a-role taxonomy. This is the full specification of each facet and the mechanisms between them.

Governing principle (`01 §II`, `00 §1`): **the Wallet is the only thing that can sign; the Account is the only thing with reputation; the Profile is the only thing with a face. Conflating them is a category error with concrete failure modes.**

---

## I. Wallet

A specific address on a specific chain. Atomic — cannot be split, cannot be merged. Has a private key, or session-key control via a smart-wallet contract (Starknet account abstraction — `00 §4`).

- **Identifier:** `(chain, address)`. Address is **normalized per chain**: Starknet pads to 64-char lowercase 0x-hex; Ethereum uses EIP-55 checksum; Bitcoin uses bech32/base58. Normalization happens before every DB write *and* every DB read (the backend already enforces this; "lowercase alone" is a known bug class — it doesn't pad short Starknet addresses).
- **The only thing that signs.** Every protocol action traces to a Wallet signature. Everything else in this model bridges *to* a Wallet.
- **Chain is load-bearing** (`00 §3`). A Wallet without its chain is not an identifier. Code that keys identity on `address` alone is a year-2 multichain blocker.

---

## II. Account

The logical actor — human, AI agent, organization, collector. Owns one or more Wallets, possibly across chains (`00 §3`: a Starknet wallet for trading IP, a Bitcoin wallet for receiving payment, one Account).

- **Identifier:** an `AccountID` from the future `AccountID` contract on Starknet — the actor-side parallel to the Asset's `IP-ID` (`01 §I`). v1 uses a **primary Wallet** as the Account identifier, with off-chain links to secondary Wallets (§IV).
- **Holds reputation, roles, work, sales history** aggregated across its Wallets. The Account is the unit XP/rewards attach to (the backend's action-based, anti-wash-trade reward system is Account-scoped — `00 §11`).
- **Year-1 reality:** an Account *is* `(chain, walletAddress)` — one Wallet, one Account. Cross-chain linkage is year-2+. The architecture must not block it; v1 must not pretend it exists.

### Roles

An Account carries one or more roles: `creator`, `collector`, `organization`, `agent`. Roles are **attributes of the Account, not primitives** (`01 §II`) and not separate tables.

- Roles gate **UI affordances** — only a creator-role Account sees launchpad authoring tools; an organization-role Account may see team views.
- Roles **never gate protocol actions** (`00 §1`, `00 §2`). Any Account that owns an Asset can trade/transfer it, role or not. A role missing means "don't show this UI," never "this is forbidden." This is the same rule as service capabilities (`05 §III`) — affordance, not authority.
- `agent` is not a lesser class. Per `00 §6`, agent Accounts transact via the same SDK/API, same fees, same flows. The role exists for operational concerns (rate-limit tier, API-key scoping), never as a permission gate.

---

## III. Profile

Off-chain enrichment for an Account: display name, bio, social handles, avatar, custom slug. Stored in `AccountProfile`, with `CreatorProfile` as the creator-role extension (the backend already splits it this way — collection slug claims, gated-content config, etc. hang off the creator-level profile).

- **Editable. Never authoritative.** Losing the entire Profile loses **no protocol state** — the Wallet's ownership, history, and Orders all persist on-chain (`01 §II`, `02 §III Account` "the (a) category of the rebuild test").
- **Legitimately platform-layer state** (`02 §III Account`): Profile, slug claims, API keys, reputation cache are *not* §1 violations because they grant no protocol authority. They pass the rebuild test by being honestly classified as off-chain, not by being reconstructable from Events.

---

## IV. Cross-chain identity: two mechanisms, never conflated

Per `00 §10` and `01 §II`, the asset side and the actor side use **different** mechanisms because they answer different questions:

| | Question | Mechanism | Canonical join |
|---|---|---|---|
| **Asset** | "Is this the same *work*?" | `IP-ID` (`01 §I`) | one `IP-ID`, many `(chain,contract,tokenId)` |
| **Account** | "Is this the same *actor*?" | signed attestations via `AccountID` | one `AccountID`, many `(chain,address)` |

"Is this the same artwork?" is about provenance — the work is a fixed thing being represented. "Is this the same actor?" is about a *claim of equivalence* — the Account is the asserter. Different epistemics, different mechanism.

### The attestation

A Wallet declares it belongs to an Account via a **signed statement on a chain the Account trusts**:

> "I, `bitcoin:bc1q…`, attest I am the same Account as `starknet:0x…`, at block N."

- The protocol verifies the signature; the indexer aggregates linked Wallets into one logical Account.
- The signing scheme (SIWS / SIWE variants per chain, chain-of-trust rules — which Wallet may attest for which, replay/nonce handling) is **deferred to implementation** when the work begins, not specified here. The *architecture* commitment is: linkage is a verifiable signed graph, never a trust-me database row.
- Stored off-chain in v1, on-chain via `AccountID` in year-2 (`00 §2`, `05 §VII` decentralization arc).

---

## V. Authentication vs authorization (the gated-content case)

The single most important distinction in this document, and the one most easily gotten wrong.

- **Authentication** = "which Account/Wallet is making this request." A platform-layer concern. The reference apps use a session/JWT mechanism plus the connected Wallet to establish *who is asking*. This is app infrastructure; the protocol does not depend on it.
- **Authorization** = "is this request permitted." For anything protocol-bearing, **the on-chain state is the authority** (`00 §1`).

Worked example — **token-gated content**:

```
request → authenticate the caller (platform-layer: who is this?)
        → authorize via ON-CHAIN ownership check (does this Wallet/Account
          actually hold a token from this collection, per the contract?)
        → only then release the gated payload
```

The load-bearing step is the **on-chain ownership check**, not the session. If the platform auth says "this is Alice" but the chain says Alice's Wallet doesn't hold the token, access is denied — the chain wins (`00 §1`). The gated-content URL is never exposed in any public profile response; only an on-chain-verified holder receives it.

Implementation detail deliberately left open: *which* session mechanism authenticates the caller, and whether the holder check keys on the connected Wallet or the aggregated Account, is a platform-layer choice that may evolve. The architecture invariant is fixed: **authorization for protocol-bearing access is the on-chain check; platform auth only identifies the requester.** Conflating the two — gating on a database/session claim instead of chain state — is a §1 violation and has caused production lockouts before (memory `feedback_medialane_values`).

---

## VI. Year-1 reality

| Facet | v1 | Year 2+ |
|---|---|---|
| Wallet | `(chain,address)`, normalized; Starknet exercised | Other chains' normalization implemented (`00 §3`) |
| Account | primary Wallet = Account; one Wallet, one Account | `AccountID` contract; cross-chain Wallet linkage |
| Roles | creator/collector/organization/agent as Account attributes | unchanged shape; richer org/team semantics |
| Profile | `AccountProfile` + `CreatorProfile`, platform-layer | unchanged; never becomes authoritative |
| Attestations | off-chain, signed, verified | on-chain via `AccountID` (`00 §2`) |
| Reputation/XP | Account-scoped, action-based (`00 §11`) | aggregates across linked Wallets |

The architecture supports the right column. v1 ships the left. Nothing in the left column makes the right unreachable — the test every entry must pass.

---

## VII. What this rules out

- **`wallet = account = profile` in one row.** The three facets have separate failure modes; conflating them blocks Wallet rotation, blocks cross-chain reputation, and ties cosmetic edits to crypto identity (`01 §X`).
- **Roles as protocol gates.** UI affordance only; the contract authorizes (`00 §1`, §II).
- **Authorizing protocol-bearing access on a session/DB claim.** The on-chain check is authority; auth only identifies (§V). This is the §1 violation with a production track record.
- **`agent` as a lesser identity.** Same SDK, same fees, same flows (`00 §6`, §II).
- **Identity keyed on `address` without `chain`.** A multichain year-2 blocker (`00 §3`, §I).
- **One mechanism for both cross-chain questions.** `IP-ID` for works, `AccountID` attestations for actors — never merged (§IV).
- **A Profile that grants authority.** Profile loss must lose zero protocol state (§III).

---

## VIII. Open questions deferred

- **Attestation signing scheme** — SIWS/SIWE variants, chain-of-trust rules, replay/nonce. Specified when the cross-chain linkage work begins; principle (verifiable signed graph) is fixed here.
- **`AccountID` contract shape** — storage, write-permission, year-2 decentralization. Surfaces in `08-dao-governance.md` and a year-2 doc, not v1.
- **Account ↔ Wallet check granularity for gated access** — connected Wallet vs aggregated Account. Platform-layer, may evolve; invariant (on-chain authority) is fixed (§V).

---

## IX. Related documents

- `00-principles.md` — §1 (contract is truth), §3 (chain load-bearing), §6 (agents first-class), §11 (action-based reputation)
- `01-core-model.md` — §II (Account: the locked taxonomy this expands), §I (`IP-ID` contrast)
- `02-protocol-app-split.md` — §III Account (platform-layer state, rebuild test)
- `05-service-model.md` — capability gating (the same affordance-not-authority rule roles follow)
- `08-dao-governance.md` — year-2 on-chain `AccountID`, decentralization arc

---

**Next document:** `08-dao-governance.md` — the DAO's role: contract ownership, the (open, platform-layer) fee schedule, service-registry curation, and the year-2+ progressive-decentralization arc — including where Mediolano's independence sits relative to Medialane governance.
