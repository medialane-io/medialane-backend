<img width="1260" height="640" alt="Medialane Backend" src="https://github.com/user-attachments/assets/a72bca86-bb82-42c4-8f61-9558484df5b9" />

# Medialane Backend

**The indexer and public API behind Medialane.**

This service reads the Medialane marketplaces and launchpad services onchain and serves that record through the public Medialane API. It powers [medialane.io](https://medialane.io), [starknet.medialane.io](https://starknet.medialane.io), [portal.medialane.io](https://portal.medialane.io) and every app built with [`@medialane/sdk`](https://github.com/medialane-io/medialane-sdk).

---

## The chain is the record

Ownership, trades and provenance live onchain. This backend is a fast, searchable view of that record, never a replacement for it: everything it holds can be rebuilt from onchain events, and no trade, mint or transfer depends on it.

- **Indexer:** follows marketplace orders, transfers and launchpad activity as they happen onchain.
- **Metadata:** resolves each asset's metadata, including its license and AI policy.
- **API:** serves assets, collections, orders, activity, creator profiles, search and remix requests to apps, developers and AI agents.

---

## Using the API

The API is available at `https://api.medialane.io`. The easiest way to use it is the TypeScript SDK:

```bash
npm install @medialane/sdk starknet
```

Get an API key at [portal.medialane.io](https://portal.medialane.io). The full API reference is at [docs.medialane.io/dev/api](https://docs.medialane.io/dev/api).

---

## Development

```bash
bun install
cp .env.example .env
bun run db:migrate
bun dev                 # API
bun run dev:worker      # indexer and background jobs
```

Before opening a pull request, run `bun run typecheck` and `bun test src`.

---

## Part of the Medialane platform

| | |
|---|---|
| [medialane-io](https://github.com/medialane-io/medialane-io) | The medialane.io app |
| [medialane-starknet](https://github.com/medialane-io/medialane-starknet) | The Starknet wallet app |
| [medialane-sdk](https://github.com/medialane-io/medialane-sdk) | `@medialane/sdk` |
| [medialane-contracts](https://github.com/medialane-io/medialane-contracts) | The smart contracts this service indexes |

---

## License

[MIT](LICENSE)
