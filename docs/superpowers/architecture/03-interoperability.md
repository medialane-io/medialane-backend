# 03 — Interoperability

**Status:** Draft for review. Builds on `00-principles.md` (§8, §9, §13), `01-core-model.md` (Asset, License), and `02-protocol-app-split.md` (the Asset layer caches this; the License layer reads it).

---

## What this is

The exact shape of an Asset's metadata: the OpenSea-compatible baseline every Medialane asset honors, and the Medialane-specific extensions that layer on top of it without breaking it.

This is the concrete answer to `00 §8` ("assets are interoperable via standards") and the encoding substrate for `00 §9` / `01 §IV` (the License lives in this metadata). `04-licensing-model.md` owns the *license taxonomy*; this document owns the *envelope* it travels in.

The one-sentence rule: **the OpenSea baseline is a floor that is never lowered; Medialane extensions are a ceiling that third parties can ignore without losing the asset.**

---

## I. Why a baseline at all

`00 §8`: interoperability is a moat, not a constraint. A Medialane-minted asset must render correctly on OpenSea, Element, X2Y2 — anywhere — so it travels with the creator if Medialane disappears (`00 §1`, `01 §I` "an Asset is not a row in our database").

That only works if Medialane's metadata is a **superset** of the OpenSea standard, never a divergent dialect. A custom schema that needs Medialane's renderer to be legible would trap the asset — exactly the vendor lock-in `00 §8` rules out.

So the differentiation lives in the **platform layer** (gated content, on-chain comments, verifiable proofs, licensing UX — `00 §8`), never in making the asset itself unreadable elsewhere.

---

## II. The baseline (the floor)

The metadata JSON pointed to by the on-chain `tokenURI`, following the OpenSea ERC-721 / ERC-1155 metadata standard:

```json
{
  "name": "Composition No. 7",
  "description": "Original score, 2026.",
  "image": "ipfs://bafy.../cover.png",
  "animation_url": "ipfs://bafy.../audio.mp3",
  "external_url": "https://medialane.app/asset/0x.../7",
  "attributes": [
    { "trait_type": "Medium", "value": "Audio" },
    { "trait_type": "Year", "value": 2026, "display_type": "number" }
  ]
}
```

Rules for the floor:

- **`name`, `description`, `image` are mandatory.** An asset without them renders as broken everywhere.
- **`attributes` is an array of `{ trait_type, value }`**, optionally `display_type` for numbers/dates/boosts. This array is the **cross-platform interop surface** — every marketplace reads it.
- **ERC-1155**: the contract's URI may contain the `{id}` substitution token; the resolved document follows the same shape.
- **`image` should be content-addressed** (IPFS/Arweave), not an HTTP URL that can rot or be swapped. The on-chain `tokenURI` is the pointer; the document it resolves to is the asset's self-description.

Nothing Medialane-specific is required to make an asset valid. A bare baseline document is a complete, tradeable, portable asset.

---

## III. The extensions (the ceiling)

Medialane adds two kinds of information. Where each goes is determined by **one question: does a third party need to see it?**

### 1. Things third parties *should* see → `attributes`

License terms and other human-meaningful facts go in the standard `attributes` array as **plain string traits**. OpenSea shows them as ordinary traits; Medialane *interprets* the same traits as a License (`01 §IV`). No special renderer required for them to be legible — they degrade to "just traits" gracefully.

### 2. Things only Medialane needs → a namespaced object

Service-specific structured data (UI hints, proof references, service payloads) goes under a single namespaced top-level key the rest of the ecosystem ignores:

```json
{
  "name": "...", "description": "...", "image": "ipfs://...",
  "attributes": [ /* License + traits — visible everywhere */ ],

  "medialane": {
    "service": "pop-protocol",
    "schemaVersion": 1,
    "serviceData": { "eventId": "...", "claimWindow": "..." }
  }
}
```

OpenSea and other marketplaces ignore unknown top-level keys, so the `medialane` object is invisible to them and harmless. This is the mechanism behind `01 §I` / `01 §III`: **"new service-specific shapes layer on top of the OpenSea baseline, never replace it."** A service may *extend* into `attributes` (more traits) and into `medialane` (structured data); it may never *remove or repurpose* a baseline field.

**The extension never changes the meaning of a baseline field.** `image` is always the cover image, even for a service that also has a 3D model — the model goes in `animation_url` or `medialane`, never by redefining `image`.

---

## IV. The License encoding

`00 §9` and `01 §IV`: the License is data on the Asset, expressed as OpenSea-compatible attributes. The canonical trait set (full taxonomy in `04-licensing-model.md`):

```json
"attributes": [
  { "trait_type": "License",        "value": "CC BY-SA" },
  { "trait_type": "Commercial Use", "value": "Allowed" },
  { "trait_type": "Derivatives",    "value": "Allowed with attribution" },
  { "trait_type": "Territory",      "value": "Worldwide" },
  { "trait_type": "AI Policy",      "value": "Training allowed with attribution" },
  { "trait_type": "Royalty",        "value": "5%" }
]
```

- **Default is `CC BY-SA`** (`00 §9`, `01 §IV`) — chosen for remixability; user can customize at mint. A service may set a different `licenseDefault` in its registry `metadataSchema` (`02`, the 2026-05-15 service-model draft §4.1), but the *encoding* is always these plain traits.
- **The `Royalty` trait is a display hint, not enforcement.** On-chain royalty enforcement, where a service opts into it, is a separate ERC-2981-style contract mechanism (`00 §9` selective enforcement). The metadata trait tells humans and third-party marketplaces the intended rate; it does not *make* anyone pay.
- **The SDK reads, never writes back.** `getLicense(asset.metadata)` returns the typed view (`01 §IV`). The indexer may cache parsed fields (`Token.licenseType`) for query speed — those are derived, never authoritative (`02` rebuild test).

---

## V. Immutability and provenance (Berne)

`00 §13`: authorship/ownership claims must be durable for Berne-Convention alignment. That durability comes from **content-addressed, immutable metadata**, not from a database row.

- **Authorship/ownership-bearing metadata is immutable.** Once minted, the `tokenURI` resolves to a fixed, content-addressed document (IPFS CID / Arweave tx). It cannot be silently rewritten. This is *why* the License and provenance claims are trustworthy — not because Medialane vouches for them, but because they are pinned, hashed, and unchangeable.
- **Mutable presentation is not in this document.** Display name overrides, profile-level curation, slugs — those are platform-layer state (`02 §III Account`), explicitly *not* part of the asset's self-describing metadata. Confusing the two would put a mutable field where an immutable claim belongs.
- **Pinning is an availability concern, not an authority one.** If Medialane stops pinning, the CID is unchanged and re-pinnable by anyone (`00 §1`, `00 §8` — the asset survives Medialane). The indexer's cached copy (`02`) is a convenience, never the source.

---

## VI. Reading metadata: the resolution pipeline

How the Asset layer (`02 §III`) actually turns a `tokenURI` into cached, queryable metadata. This is the existing backend behavior, stated as architecture:

```
on-chain tokenURI  →  resolve  →  fetch  →  cache (MetadataCache / Token)
                        │
                        ├─ ipfs://  → gateway chain: Pinata → Cloudflare → ipfs.io
                        ├─ data:    → inline decode
                        └─ https:// → direct (least durable; discouraged for new mints)
```

Load-bearing details that the architecture depends on:

- **`tokenURI` is a Cairo `ByteArray`.** Modern OZ ERC-721 returns it as a `ByteArray` struct; the decoder must include the struct definition or it truncates CIDs and silently produces invalid IPFS pointers. This is a correctness invariant of the Asset layer, not an optimization. (Backend: `ERC721_METADATA_ABI_BYTEARRAY`; try-ByteArray-then-fallback-to-felt-array.)
- **Resolution is gateway-redundant.** No single IPFS gateway is authoritative; the fallback chain exists because availability ≠ authority (§V).
- **`MetadataStatus` is a bounded lifecycle** (PENDING → resolved/FAILED), and results *including failures* are cached (`MetadataCache`) so a dead CID isn't re-hammered. JIT resolution (`?wait=true`) blocks briefly but still only ever *caches* — it never becomes a parallel source of truth (`02 §IV`).

---

## VII. Year-1 reality

| Concern | v1 | Later |
|---|---|---|
| Baseline | OpenSea ERC-721 / ERC-1155 metadata, honored by all live services | Same — the floor never moves |
| Extensions | `attributes` for License; `medialane` object thin (mostly `service` + UI hints) | Richer `serviceData`, verifiable-proof references (`00 §7`) |
| License taxonomy | CC BY-SA default + the canonical trait set above | Full customization flow → `04-licensing-model.md` |
| Storage | IPFS via Pinata, content-addressed, gateway-redundant resolution | Arweave option, Bitcoin-anchored license registry (`00 §3`) |
| Indexer cache | Resolved metadata + parsed license traits on `Token` | Same shape; data-driven per-service parsers (`02 §V`) |

The floor and the encoding are locked now. Everything in the right column extends the `medialane` object or the license taxonomy — never the baseline.

---

## VIII. What this rules out

- **A divergent metadata dialect.** Any shape that needs Medialane's renderer to be legible traps the asset and violates `00 §8`.
- **Repurposing a baseline field.** `image` meaning anything but the cover image; stuffing structured JSON into `description`. Extensions go in `attributes` or `medialane`, never by overloading the floor.
- **License as a non-attribute.** Encoding license terms somewhere a third-party marketplace can't see them defeats the interop point of `01 §IV`. License-as-traits is mandatory.
- **Mutable ownership/authorship claims.** A rewritable HTTP URL or a DB-sourced "license" for the authoritative claim breaks Berne alignment (`00 §13`, §V).
- **Treating a gateway or the indexer cache as authoritative.** The content-addressed document is the truth; everything else is a redundant copy (`02 §IV`).
- **Enforcement implied by a trait.** The `Royalty` trait is a hint. Believing it is enforced on-chain when no service opted into enforcement is the "pretends licensing is enforced" anti-pattern `00 §9` rules out.

---

## IX. Related documents

- `00-principles.md` — §8 (interoperability moat), §9 (licensing in metadata, soft-enforced), §13 (Mediolano / Berne / immutable metadata)
- `01-core-model.md` — Asset (§I), License as a view not an entity (§IV)
- `02-protocol-app-split.md` — the Asset layer caches this document; the License layer reads it; the rebuild test
- `04-licensing-model.md` — the license attribute taxonomy this envelope carries, customization flow, selective on-chain enforcement
- `05-service-model.md` — `metadataSchema` per service (required traits, license default) in the registry

---

**Next document:** `04-licensing-model.md` — the programmable license taxonomy in detail: the full attribute set beyond CC BY-SA, the mint-time customization flow, and where selective on-chain enforcement is and isn't appropriate.
