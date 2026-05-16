# 04 — Licensing Model

**Status:** Draft for review. Builds on `00-principles.md` (§9 soft enforcement, §13 Mediolano/Berne), `01-core-model.md` (§IV License as a view, not an entity), `03-interoperability.md` (the attribute envelope the License travels in).

---

## What this is

The programmable license: its full attribute taxonomy, how a creator chooses or customizes one at mint, and exactly where on-chain enforcement is appropriate versus where it is a mistake.

`03` defined the *envelope* (License = plain `attributes` traits, third-party-visible, immutable). This document defines the *contents* of that envelope and the *rules around changing and enforcing them*.

The governing principle (`00 §9`): **a license is a declaration in metadata, soft-enforced by default; on-chain enforcement is selective and opt-in per service, never the default.**

---

## I. Why licensing is programmable, not contractual-by-default

IP law varies across 181 Berne-Convention jurisdictions (`00 §13`). Three consequences shape the entire model:

1. **Contracts are immutable; laws are not.** Hardcoding "US fair use" or "EU exception" into an immutable contract ages badly and fragments by territory (`00 §9`). So the license is *data*, interpreted by the platform/partner layer, not contract logic.
2. **The claim must be durable.** Authorship/ownership terms ride in content-addressed, immutable metadata (`03 §V`) — that immutability is what makes the claim Berne-trustworthy, not a Medialane attestation.
3. **Mediolano provides the substrate.** The zero-fee, Berne-aligned tokenization + programmable-licensing primitives live in Mediolano (`00 §13`). Medialane adds the *UX* for choosing and customizing licenses, plus the commercial layer. Medialane never makes a license less free than Mediolano would.

---

## II. The taxonomy

A license is a small, bounded set of attribute traits (the canonical six from `03 §IV`, plus the extended set below). Bounded on purpose — a free-form legal blob is unreadable to third parties and to agents (`00 §6`). Anything genuinely outside the set is a signal to extend the *taxonomy*, not to abandon it (mirrors the capability-set rule in `01 §III`).

### Core traits (always present)

| `trait_type` | Allowed values | Meaning |
|---|---|---|
| `License` | preset id (`CC BY-SA`, `CC BY`, `CC0`, `All Rights Reserved`, `Custom`) | The headline. Presets expand to the traits below. `Custom` means the traits are author-set. |
| `Commercial Use` | `Allowed` · `Not allowed` · `Allowed with royalty` | May a licensee monetize? |
| `Derivatives` | `Allowed` · `Allowed with attribution` · `Share-alike` · `Not allowed` | May a licensee remix? `Share-alike` = derivative must carry the same license. |
| `Attribution` | `Required` · `Not required` | Must the original creator be credited? |
| `Territory` | `Worldwide` · ISO-3166 list | Where the grant applies. |
| `AI Policy` | `Training allowed` · `Training allowed with attribution` · `Training not allowed` · `Inference only` | First-class because agents are first-class users (`00 §6`). |
| `Royalty` | percentage string (`5%`) or `None` | **Display hint only** — see §V. |

### Extended traits (present when the preset or author sets them)

| `trait_type` | Allowed values | Meaning |
|---|---|---|
| `Exclusivity` | `Non-exclusive` · `Exclusive` | Default `Non-exclusive`. |
| `Term` | `Perpetual` · ISO-8601 duration/date | Time bound of the grant. |
| `Sublicensing` | `Allowed` · `Not allowed` | May a licensee re-license onward? |
| `Revocable` | `No` · `Yes (conditions)` | Default `No` — a revocable on-chain grant is mostly theatre unless a service enforces it (§V). |
| `Custom Terms` | `ipfs://…` | Pointer to bespoke legal text when `License: Custom`. The pointer is immutable like the rest of the metadata (`03 §V`). |

The SDK exposes this as one typed accessor — `getLicense(asset.metadata)` (`01 §IV`) — returning the resolved object. Consumers never parse traits by hand.

---

## III. Presets

A preset is just a named expansion into the trait set. The creator picks a preset; the mint writes the expanded traits. There is no "preset" stored separately — storing only `License: CC BY-SA` without the expanded traits would force every reader to embed CC semantics. The expansion *is* the license (consistent with `01 §IV` "License as data, not entity").

| Preset | Commercial | Derivatives | Attribution | AI Policy |
|---|---|---|---|---|
| **`CC BY-SA`** *(default)* | Allowed | Share-alike | Required | Training allowed with attribution |
| `CC BY` | Allowed | Allowed with attribution | Required | Training allowed with attribution |
| `CC0` | Allowed | Allowed | Not required | Training allowed |
| `All Rights Reserved` | Not allowed | Not allowed | Required | Training not allowed |
| `Custom` | author-set | author-set | author-set | author-set |

**`CC BY-SA` is the platform default** (`00 §9`, `01 §IV`) — chosen for remix culture: share-alike keeps derivatives open. A *service* may declare a different default via its registry `metadataSchema.licenseDefault` (`05-service-model.md`). The canonical default string is exactly **`CC BY-SA`** — the `CC-BY-4.0` example in the 2026-05-15 service-model draft is superseded and is corrected when `05` rescopes it.

---

## IV. The mint-time customization flow

```
choose preset ──► (optional) customize traits ──► preview resolved license
                                                        │
                                                        ▼
                                   freeze into immutable metadata at mint
```

- **Choice and customization happen *before* the metadata is sealed.** The creator may start from a preset and override individual traits (e.g. `CC BY` but `Commercial Use: Not allowed`), which sets `License: Custom`.
- **At mint the license is frozen** into the content-addressed document (`03 §V`). It is now immutable.
- **"Changing a license" is not an edit.** Because the metadata is immutable, there is no mutate path. A creator who wants different terms issues a *new* representation/version (a new Asset, or a new chain representation under the same `IP-ID` — `01 §I`), with its own license. The original's terms remain provable forever. This is a feature (Berne durability), not a limitation.
- **The platform may show a generated human-readable summary**, but the traits are authoritative; the prose is derived (same posture as the indexer's parsed-license cache in `03 §IV`).

---

## V. Enforcement: soft by default, on-chain by exception

This is the section most likely to be gotten wrong, so it is explicit.

### Soft enforcement is the default

`00 §9`: the default service contracts **do not revert** on a license violation. A derivative minted without honoring `Share-alike` is not blocked by the chain. Enforcement is interpretive, at the app/partner layer, per jurisdiction. The contract stays simple and durable; policy adapts off-chain.

This is *intentional*, not a gap. Pretending otherwise — UI that implies on-chain enforcement where there is none — is the anti-pattern `00 §9` explicitly rules out.

### Selective on-chain enforcement (opt-in, per service)

Some flows genuinely require enforcement and a service may bake it into *its own* contract. The legitimate cases:

| Case | Mechanism | Why on-chain is justified |
|---|---|---|
| Resale royalty split | ERC-2981 (or service-specific split) | The payment must be atomic with the trade; off-chain can't guarantee it. |
| License-negotiation escrow | Escrow contract | Funds must be held trustlessly during negotiation. |
| Time-locked unlock | Time-lock in the service contract | "Available after date X" must be tamper-proof. |
| Revocable grant | Service-enforced revocation | A `Revocable: Yes` license is only meaningful if a service actually enforces it. |

Rules around the exceptions:

- **A service that enforces declares it** — via its capabilities / registry definition (`05-service-model.md`), so the platform, agents, and third parties can see that this service's contract is stricter than the default.
- **The `Royalty` trait remains a hint.** It states *intent*. Whether it is *enforced* depends on whether the asset's service opted into ERC-2981-style enforcement. A third-party marketplace that ignores ERC-2981 is exercising `00 §5`, not breaking Medialane — the metadata told the truth ("intended 5%"); enforcement was always service-scoped.
- **Default services never enforce.** `mip-erc721`, `mip-erc1155`, `ip-erc721` issue assets with soft licenses. Enforcement is never silently added to a default path.

---

## VI. Year-1 reality

| Concern | v1 | Later |
|---|---|---|
| Presets | CC BY-SA (default), CC BY, CC0, All Rights Reserved, Custom | More named presets as creators ask |
| Trait set | Core + extended above, encoded as `03` attributes | Jurisdiction-specific extensions, additive only |
| Customization | Mint-time preset + per-trait override; immutable after | Same flow; richer preview/summary UX |
| Enforcement | Soft everywhere; ERC-2981 only where a service opts in | Escrow/time-lock/revocation services as they ship (`05`) |
| Mediolano coupling | Medialane UX over Mediolano's licensing primitives | Bitcoin-anchored license registry (`00 §3`) for the most durable proof |

The taxonomy and the soft-by-default posture are locked now. Everything later is additive traits or additional opt-in enforcement services — never a change to the default being soft.

---

## VII. What this rules out

- **Baking jurisdiction policy into contracts.** Immutable + territory-fragmenting + ages badly (`00 §9`).
- **A mutable license.** No edit path on sealed metadata; new terms = new representation (§IV, `03 §V`).
- **License stored where third parties can't read it.** It must be `attributes` traits (`03 §III`); a Medialane-only license is a non-interoperable license.
- **UI that implies on-chain enforcement that doesn't exist.** The single most important anti-pattern here (`00 §9`).
- **Enforcement on a default service path.** Strictness is opt-in and declared, never silent (§V).
- **Treating the `Royalty` trait as a guarantee.** It is intent; enforcement is service-scoped and visible.
- **A free-form legal blob as *the* license.** Bespoke text is allowed only as an *immutable `Custom Terms` pointer alongside* the bounded traits — never instead of them (agents and third parties must still read the structured grant — `00 §6`).

---

## VIII. Related documents

- `00-principles.md` — §9 (soft enforcement, jurisdictional rationale), §13 (Mediolano substrate, Berne)
- `01-core-model.md` — §IV (License as a view on Asset metadata, not an entity), §I (`IP-ID` / new representations)
- `03-interoperability.md` — the attribute envelope, immutability/provenance, the `Royalty`-as-hint rule
- `05-service-model.md` — `metadataSchema.licenseDefault` per service; how a service *declares* opt-in enforcement
- `08-dao-governance.md` — who governs the preset catalogue and any future enforced-royalty parameters

---

**Next document:** `05-service-model.md` — the Service primitive in depth, rescoping the 2026-05-15 asset/service-model draft onto the locked principles: the registry shape, the capability set, canonical service IDs, and how a service declares its metadata schema and any opt-in enforcement.
