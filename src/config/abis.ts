// Full ABI sourced from deployed contract on Starknet mainnet
// Contract: 0x04299b51289aa700de4ce19cc77bcea8430bfd1aef04193efab09d60a3a7ee0f
export const IPMarketplaceABI = [
  {
    type: "impl",
    name: "UpgradeableImpl",
    interface_name: "openzeppelin_upgrades::interface::IUpgradeable",
  },
  {
    type: "interface",
    name: "openzeppelin_upgrades::interface::IUpgradeable",
    items: [
      {
        type: "function",
        name: "upgrade",
        inputs: [
          {
            name: "new_class_hash",
            type: "core::starknet::class_hash::ClassHash",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
    ],
  },
  {
    type: "impl",
    name: "MedialaneImpl",
    interface_name: "mediolano_core::core::interface::IMedialane",
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::OfferItem",
    members: [
      { name: "item_type", type: "core::felt252" },
      {
        name: "token",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "identifier_or_criteria", type: "core::felt252" },
      { name: "start_amount", type: "core::felt252" },
      { name: "end_amount", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::ConsiderationItem",
    members: [
      { name: "item_type", type: "core::felt252" },
      {
        name: "token",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "identifier_or_criteria", type: "core::felt252" },
      { name: "start_amount", type: "core::felt252" },
      { name: "end_amount", type: "core::felt252" },
      {
        name: "recipient",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::OrderParameters",
    members: [
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "offer", type: "mediolano_core::core::types::OfferItem" },
      {
        name: "consideration",
        type: "mediolano_core::core::types::ConsiderationItem",
      },
      { name: "start_time", type: "core::felt252" },
      { name: "end_time", type: "core::felt252" },
      { name: "salt", type: "core::felt252" },
      { name: "nonce", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::Order",
    members: [
      {
        name: "parameters",
        type: "mediolano_core::core::types::OrderParameters",
      },
      { name: "signature", type: "core::array::Array::<core::felt252>" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::OrderFulfillment",
    members: [
      { name: "order_hash", type: "core::felt252" },
      {
        name: "fulfiller",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "nonce", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::FulfillmentRequest",
    members: [
      {
        name: "fulfillment",
        type: "mediolano_core::core::types::OrderFulfillment",
      },
      { name: "signature", type: "core::array::Array::<core::felt252>" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::OrderCancellation",
    members: [
      { name: "order_hash", type: "core::felt252" },
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "nonce", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::CancelRequest",
    members: [
      {
        name: "cancelation",
        type: "mediolano_core::core::types::OrderCancellation",
      },
      { name: "signature", type: "core::array::Array::<core::felt252>" },
    ],
  },
  {
    type: "enum",
    name: "mediolano_core::core::types::OrderStatus",
    variants: [
      { name: "None", type: "()" },
      { name: "Created", type: "()" },
      { name: "Filled", type: "()" },
      { name: "Cancelled", type: "()" },
    ],
  },
  {
    type: "enum",
    name: "core::option::Option::<core::starknet::contract_address::ContractAddress>",
    variants: [
      {
        name: "Some",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "None", type: "()" },
    ],
  },
  {
    type: "struct",
    name: "mediolano_core::core::types::OrderDetails",
    members: [
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "offer", type: "mediolano_core::core::types::OfferItem" },
      {
        name: "consideration",
        type: "mediolano_core::core::types::ConsiderationItem",
      },
      { name: "start_time", type: "core::integer::u64" },
      { name: "end_time", type: "core::integer::u64" },
      {
        name: "order_status",
        type: "mediolano_core::core::types::OrderStatus",
      },
      {
        name: "fulfiller",
        type: "core::option::Option::<core::starknet::contract_address::ContractAddress>",
      },
    ],
  },
  {
    type: "interface",
    name: "mediolano_core::core::interface::IMedialane",
    items: [
      {
        type: "function",
        name: "register_order",
        inputs: [
          { name: "order", type: "mediolano_core::core::types::Order" },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "fulfill_order",
        inputs: [
          {
            name: "fulfillment_request",
            type: "mediolano_core::core::types::FulfillmentRequest",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "cancel_order",
        inputs: [
          {
            name: "cancel_request",
            type: "mediolano_core::core::types::CancelRequest",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "get_order_details",
        inputs: [{ name: "order_hash", type: "core::felt252" }],
        outputs: [{ type: "mediolano_core::core::types::OrderDetails" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_order_hash",
        inputs: [
          {
            name: "parameters",
            type: "mediolano_core::core::types::OrderParameters",
          },
          {
            name: "signer",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [{ type: "core::felt252" }],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "impl",
    name: "NoncesImpl",
    interface_name: "openzeppelin_utils::cryptography::interface::INonces",
  },
  {
    type: "interface",
    name: "openzeppelin_utils::cryptography::interface::INonces",
    items: [
      {
        type: "function",
        name: "nonces",
        inputs: [
          {
            name: "owner",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [{ type: "core::felt252" }],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "impl",
    name: "SRC5Impl",
    interface_name: "openzeppelin_introspection::interface::ISRC5",
  },
  {
    type: "enum",
    name: "core::bool",
    variants: [
      { name: "False", type: "()" },
      { name: "True", type: "()" },
    ],
  },
  {
    type: "interface",
    name: "openzeppelin_introspection::interface::ISRC5",
    items: [
      {
        type: "function",
        name: "supports_interface",
        inputs: [{ name: "interface_id", type: "core::felt252" }],
        outputs: [{ type: "core::bool" }],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "impl",
    name: "AccessControlImpl",
    interface_name:
      "openzeppelin_access::accesscontrol::interface::IAccessControl",
  },
  {
    type: "interface",
    name: "openzeppelin_access::accesscontrol::interface::IAccessControl",
    items: [
      {
        type: "function",
        name: "has_role",
        inputs: [
          { name: "role", type: "core::felt252" },
          {
            name: "account",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [{ type: "core::bool" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_role_admin",
        inputs: [{ name: "role", type: "core::felt252" }],
        outputs: [{ type: "core::felt252" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "grant_role",
        inputs: [
          { name: "role", type: "core::felt252" },
          {
            name: "account",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "revoke_role",
        inputs: [
          { name: "role", type: "core::felt252" },
          {
            name: "account",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "renounce_role",
        inputs: [
          { name: "role", type: "core::felt252" },
          {
            name: "account",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
    ],
  },
  {
    type: "constructor",
    name: "constructor",
    inputs: [
      {
        name: "manager",
        type: "core::starknet::contract_address::ContractAddress",
      },
      {
        name: "native_token_address",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
  },
  // ── Events ──────────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "mediolano_core::core::events::OrderCreated",
    kind: "struct",
    members: [
      { name: "order_hash", type: "core::felt252", kind: "key" },
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
    ],
  },
  {
    type: "event",
    name: "mediolano_core::core::events::OrderFulfilled",
    kind: "struct",
    members: [
      { name: "order_hash", type: "core::felt252", kind: "key" },
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      {
        name: "fulfiller",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
    ],
  },
  {
    type: "event",
    name: "mediolano_core::core::events::OrderCancelled",
    kind: "struct",
    members: [
      { name: "order_hash", type: "core::felt252", kind: "key" },
      {
        name: "offerer",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_utils::cryptography::nonces::NoncesComponent::Event",
    kind: "enum",
    variants: [],
  },
  {
    type: "event",
    name: "openzeppelin_upgrades::upgradeable::UpgradeableComponent::Upgraded",
    kind: "struct",
    members: [
      {
        name: "class_hash",
        type: "core::starknet::class_hash::ClassHash",
        kind: "data",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_upgrades::upgradeable::UpgradeableComponent::Event",
    kind: "enum",
    variants: [
      {
        name: "Upgraded",
        type: "openzeppelin_upgrades::upgradeable::UpgradeableComponent::Upgraded",
        kind: "nested",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_introspection::src5::SRC5Component::Event",
    kind: "enum",
    variants: [],
  },
  {
    type: "event",
    name: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleGranted",
    kind: "struct",
    members: [
      { name: "role", type: "core::felt252", kind: "data" },
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
      {
        name: "sender",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleGrantedWithDelay",
    kind: "struct",
    members: [
      { name: "role", type: "core::felt252", kind: "data" },
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
      {
        name: "sender",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
      { name: "delay", type: "core::integer::u64", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleRevoked",
    kind: "struct",
    members: [
      { name: "role", type: "core::felt252", kind: "data" },
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
      {
        name: "sender",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "data",
      },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleAdminChanged",
    kind: "struct",
    members: [
      { name: "role", type: "core::felt252", kind: "data" },
      { name: "previous_admin_role", type: "core::felt252", kind: "data" },
      { name: "new_admin_role", type: "core::felt252", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::Event",
    kind: "enum",
    variants: [
      {
        name: "RoleGranted",
        type: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleGranted",
        kind: "nested",
      },
      {
        name: "RoleGrantedWithDelay",
        type: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleGrantedWithDelay",
        kind: "nested",
      },
      {
        name: "RoleRevoked",
        type: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleRevoked",
        kind: "nested",
      },
      {
        name: "RoleAdminChanged",
        type: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::RoleAdminChanged",
        kind: "nested",
      },
    ],
  },
  // Top-level contract Event enum — required by starknet.js for ABI consistency validation
  {
    type: "event",
    name: "mediolano_core::core::medialane::Medialane::Event",
    kind: "enum",
    variants: [
      {
        name: "OrderCreated",
        type: "mediolano_core::core::events::OrderCreated",
        kind: "nested",
      },
      {
        name: "OrderFulfilled",
        type: "mediolano_core::core::events::OrderFulfilled",
        kind: "nested",
      },
      {
        name: "OrderCancelled",
        type: "mediolano_core::core::events::OrderCancelled",
        kind: "nested",
      },
      {
        name: "NoncesEvent",
        type: "openzeppelin_utils::cryptography::nonces::NoncesComponent::Event",
        kind: "flat",
      },
      {
        name: "UpgradeableEvent",
        type: "openzeppelin_upgrades::upgradeable::UpgradeableComponent::Event",
        kind: "flat",
      },
      {
        name: "SRC5Event",
        type: "openzeppelin_introspection::src5::SRC5Component::Event",
        kind: "flat",
      },
      {
        name: "AccessControlEvent",
        type: "openzeppelin_access::accesscontrol::accesscontrol::AccessControlComponent::Event",
        kind: "flat",
      },
    ],
  },
] as const;
