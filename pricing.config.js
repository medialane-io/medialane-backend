
export const PRICING = [

  { action: "read", usd: 0.01, note: "Any lookup / GET request" },
  { action: "price:read", usd: 0.01, note: "USD price quote (STRK/ETH/USDC/WBTC)" },
  { action: "tickets:read-onchain", usd: 0.01, note: "Live ip-tickets tier state read (maxSupply/minted/validity)" },
  { action: "club:read-onchain", usd: 0.01, note: "Live ip-club membership state read (maxSupply/minted/validity)" },
  { action: "ipnft:read-onchain", usd: 0.01, note: "Live ip-erc721 full-token-data read (owner/metadata/creator)" },

  { action: "rpc:call", usd: 0.01, note: "Per RPC call an app forwards on a user's behalf" },

  { action: "auth:email-send", usd: 0.02, note: "Send one verification code by email" },

  { action: "paymaster:invoke-build",   usd: 0.01, note: "Build a sponsored invoke (no gas spent yet)" },
  { action: "paymaster:invoke-execute", usd: 0.02, note: "Execute a sponsored invoke (Medialane pays the sponsorship)" },
  { action: "paymaster:deploy-build",   usd: 0.05, note: "Build a sponsored wallet deploy (no gas spent yet)" },
  { action: "paymaster:deploy-execute", usd: 0.05, note: "Execute a sponsored wallet deploy (Medialane pays the sponsorship)" },

  { action: "wallet:deploy", usd: 0.05, note: "Provision a wallet for a recipient" },

  { action: "metadata:upload-json", usd: 0.02, note: "Upload metadata JSON to IPFS (max 512KB)" },
  { action: "metadata:upload-file", usd: 0.02, note: "Upload a media file to IPFS (max 10MB)" },

  { action: "intent:listing",      usd: 0.01, note: "List an asset for sale" },
  { action: "intent:offer",        usd: 0.01, note: "Make an offer" },
  { action: "intent:cancel",       usd: 0.01, note: "Cancel an order" },
  { action: "intent:fulfill",      usd: 0.10, note: "Buy / fulfill an order" },
  { action: "intent:counter-offer",usd: 0.01, note: "Counter an offer" },
  { action: "intent:checkout",     usd: 0.02, note: "Checkout" },

  { action: "intent:mint",             usd: 0.05, note: "Mint an asset" },
  { action: "intent:create-collection",usd: 0.05, note: "Deploy a collection" },
  { action: "intent:create-tier",      usd: 0.05, note: "Create a ticket type / membership tier" },
  { action: "intent:create-coin",      usd: 0.05, note: "Deploy a Creator Coin" },
  { action: "intent:launch-coin",      usd: 0.10, note: "Launch a Creator Coin on Ekubo" },
];
