import { hash } from "starknet";
import { STARKNET_IP_TICKETS_FACTORY_CONTRACT } from "../../../config/constants.js";
import { buildCreateCollectionIntent, buildCreateTierIntent, buildMintIntent } from "../../../orchestrator/intent/index.js";
import { IDENTITY_SCHEME } from "../../../utils/identity.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { resolveRecipientWallets } from "../../../utils/recipientWallets.js";
import {
  productionProvisioningDeps,
  registerProvisioning,
  type RegisterInput,
  type RegisterResult,
} from "../../../api/routes/business-provisioning.js";

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

export interface TicketingDeps {
  collectionCalls(input: { owner: string; name: string; symbol: string; baseUri: string }): Promise<Call[]>;
  tierCalls(input: {
    owner: string;
    collection: string;
    maxSupply: string;
    royaltyBps: number;
    metadataUri: string;
    startTime?: number;
    endTime?: number;
  }): Promise<Call[]>;
  mintCalls(input: { owner: string; recipient: string; collection: string; ticketId: string }): Promise<Call[]>;
  resolveWallets(guests: string[]): Promise<{ recipientValue: string; walletAddress: string | null }[]>;
  registerWallet(apiClient: { id: string; accountId: string }, input: RegisterInput): Promise<RegisterResult>;
  factory(): string;
}

const SERVICE = "ip-ticketing";

export const productionTicketingDeps: TicketingDeps = {
  collectionCalls: async ({ owner, name, symbol, baseUri }) =>
    (await buildCreateCollectionIntent({ owner, name, symbol, baseUri, service: SERVICE } as never)).calls as Call[],
  tierCalls: async (input) => (await buildCreateTierIntent({ ...input, service: SERVICE } as never)).calls as Call[],
  mintCalls: async ({ owner, recipient, collection, ticketId }) =>
    (await buildMintIntent({ owner, recipient, collectionContract: collection, tokenId: ticketId, amount: "1" } as never))
      .calls as Call[],
  resolveWallets: (guests) => resolveRecipientWallets("STARKNET", IDENTITY_SCHEME.EMAIL, guests),
  registerWallet: (apiClient, input) => registerProvisioning(productionProvisioningDeps, apiClient, input),
  factory: () => normalizeAddress("STARKNET", STARKNET_IP_TICKETS_FACTORY_CONTRACT),
};

export const TICKET_CREATED_SELECTOR = hash.getSelectorFromName("TicketCreated");
