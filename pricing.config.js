// ─────────────────────────────────────────────────────────────────────────
// MEDIALANE API PRICING — edit this file, then run: bun run pricing:apply
// (or, to push straight to production: bun run pricing:apply:prod)
//
// Prices are in USD. 1 credit = $0.01, so $0.05 = 5 credits. Changes are
// live immediately after you run the apply script — no deploy needed.
//
// Every row below is ONE PRICE. `chain` and `service` are optional:
//   - Leave them out to set the price for everything (the default).
//   - Add `service` to price ONE service differently (e.g. edition mints
//     cost more than single mints).
//   - Add `chain` to price ONE chain differently (e.g. Ethereum gas costs
//     more than Starknet). Only "STARKNET" is live today.
//
// More specific rows always win over the default. Delete a row to remove
// that price — it falls back to the next most general row automatically.
// ─────────────────────────────────────────────────────────────────────────

export const PRICING = [

  // ── Reads ──────────────────────────────────────────────────────────────
  { action: "read", usd: 0.01, note: "Any lookup / GET request" },
  { action: "price:read", usd: 0.01, note: "USD price quote (STRK/ETH/USDC/WBTC)" },
  { action: "tickets:read-onchain", usd: 0.01, note: "Live ip-tickets tier state read (maxSupply/minted/validity)" },
  { action: "club:read-onchain", usd: 0.01, note: "Live ip-club membership state read (maxSupply/minted/validity)" },
  { action: "ipnft:read-onchain", usd: 0.01, note: "Live ip-erc721 full-token-data read (owner/metadata/creator)" },

  // ── RPC (per app-initiated on-chain RPC call — nonce, fee estimate,
  //    tx submit, receipt poll, etc.) — every call an app forwards to Alchemy
  //    on a user's behalf gets billed here, same as every other API action.
  { action: "rpc:call", usd: 0.01, note: "Per RPC call an app forwards on a user's behalf" },

  // ── AVNU paymaster (gas-sponsored wallet actions, io only) ────────────
  // build only constructs typed data (no gas spent yet); execute is where
  // AVNU actually pays real gas, so it's priced at the write-intent tier.
  { action: "paymaster:invoke-build",   usd: 0.01, note: "Build a sponsored invoke (no gas spent yet)" },
  { action: "paymaster:invoke-execute", usd: 0.05, note: "Execute a sponsored invoke (AVNU pays real gas)" },
  { action: "paymaster:deploy-build",   usd: 0.01, note: "Build a sponsored wallet deploy (no gas spent yet)" },
  { action: "paymaster:deploy-execute", usd: 0.05, note: "Execute a sponsored wallet deploy (AVNU pays real gas)" },

  // ── Storage (IPFS via Pinata) ─────────────────────────────────────────
  // Real pinning cost — was previously falling through to the "read" price
  // ($0.01) unpriced. Caps: JSON up to 512KB, files (image/video/audio/pdf)
  // up to 10MB.
  { action: "metadata:upload-json", usd: 0.05, note: "Upload metadata JSON to IPFS (max 512KB)" },
  { action: "metadata:upload-file", usd: 0.15, note: "Upload a media file to IPFS (max 10MB)" },

  // ── Trading (marketplace) ─────────────────────────────────────────────
  { action: "intent:listing",      usd: 0.05, note: "List an asset for sale" },
  { action: "intent:offer",        usd: 0.05, note: "Make an offer" },
  { action: "intent:cancel",       usd: 0.05, note: "Cancel an order" },
  { action: "intent:fulfill",      usd: 0.50, note: "Buy / fulfill an order" },
  { action: "intent:counter-offer",usd: 0.10, note: "Counter an offer" },
  { action: "intent:checkout",     usd: 0.05, note: "Checkout" },

  // ── Minting & creation — DEFAULT price (applies to every service below
  //    unless you add a specific row for that service further down) ──────
  { action: "intent:mint",             usd: 0.25, note: "Mint an asset — default" },
  { action: "intent:create-collection",usd: 0.25, note: "Deploy a collection — default" },
  { action: "intent:create-tier",      usd: 0.50, note: "Create a ticket type / membership tier — default" },
  { action: "intent:create-coin",      usd: 0.25, note: "Deploy a Creator Coin" },
  { action: "intent:launch-coin",      usd: 0.50, note: "Launch a Creator Coin on Ekubo" },

  // ── Onboarding ───────────────────────────────────────────────────────

  // ── Per-service prices ───────────────────────────────────────────────
  // Uncomment a line and set its price to charge that ONE service
  // differently from the default above.
  //
  // Deploy a collection (per-creator factory, or a registry entry):
  // { action: "intent:create-collection", service: "mip-erc721",     usd: 0.20, note: "Deploy a new IP Collection" },
  // { action: "intent:create-collection", service: "mip-erc1155",    usd: 0.20, note: "Deploy a new NFT Editions collection" },
  // { action: "intent:create-collection", service: "ip-tickets",     usd: 0.20, note: "Deploy a new IP Tickets collection" },
  // { action: "intent:create-collection", service: "ip-club",        usd: 0.20, note: "Deploy a new IP Club collection" },
  // { action: "intent:create-collection", service: "pop-protocol",   usd: 0.20, note: "Deploy a new POP credential collection" },
  // { action: "intent:create-collection", service: "drop-collection",usd: 0.20, note: "Deploy a new Collection Drop" },
  //
  // Mint into a collection:
  // { action: "intent:mint", service: "mip-erc721",  usd: 0.05, note: "IP Collection — single-edition mint" },
  // { action: "intent:mint", service: "ip-erc721",   usd: 0.05, note: "Programmable IP (genesis) mint" },
  // { action: "intent:mint", service: "mip-erc1155", usd: 0.10, note: "NFT Editions — new edition mint" },
  // { action: "intent:mint", service: "ip-tickets",  usd: 0.05, note: "IP Tickets — mint more of an existing ticket type" },
  // { action: "intent:mint", service: "ip-club",     usd: 0.05, note: "IP Club — mint more of an existing membership tier" },
  //
  // Create a ticket type / membership tier (before minting copies of it):
   { action: "intent:create-tier", service: "ip-tickets", usd: 0.50, note: "Create a new ticket type" },
   { action: "intent:create-tier", service: "ip-club",    usd: 0.50, note: "Create a new membership tier" },
  //
  // Sponsorship (create/bid/accept/etc.) routes through /v1/intents/sponsorship-*
  // and prices off the shared "read"/intent defaults above — add explicit
  // { action: "intent:sponsorship-offer", usd: ... } rows here to price it
  // separately once its real usage volume is known.

  // ── Per-chain prices ─────────────────────────────────────────────────
  // Uncomment once a chain other than Starknet is live, to charge more
  // where gas actually costs more.
  //
  // { action: "intent:mint", chain: "ETHEREUM", usd: 0.50, note: "Ethereum mint — gas costs more" },

];
