import { STARKNET_POP_FACTORY_CONTRACT } from "../../../config/constants.js";
import { buildCreateCollectionIntent, buildMintIntent } from "../../../orchestrator/intent/index.js";
import { normalizeAddress } from "../../../utils/starknet.js";
import { resolveRecipientWallets, type RecipientWallet } from "../../../utils/recipientWallets.js";
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

export interface CertificateEmissionDeps {
  collectionCalls(input: { owner: string; name: string; symbol: string; baseUri: string }): Promise<Call[]>;
  mintCalls(input: { owner: string; recipient: string; collection: string; tokenUri: string }): Promise<Call[]>;
  resolveWallets(guests: string[]): Promise<RecipientWallet[]>;
  registerWallet(input: RegisterInput): Promise<RegisterResult>;
  factory(): string;
}

export const productionCertificateEmissionDeps: CertificateEmissionDeps = {
  collectionCalls: async ({ owner, name, symbol, baseUri }) =>
    (await buildCreateCollectionIntent({
      owner,
      name,
      symbol,
      baseUri,
      service: "pop-protocol",
      claimEndTimestamp: 0,
      eventType: "Course",
    } as never)).calls as Call[],
  mintCalls: async ({ owner, recipient, collection, tokenUri }) =>
    (await buildMintIntent({ owner, recipient, collectionContract: collection, customUri: tokenUri } as never)).calls as Call[],
  resolveWallets: (guests) => resolveRecipientWallets("STARKNET", guests),
  registerWallet: (input) => registerProvisioning(productionProvisioningDeps, input),
  factory: () => normalizeAddress("STARKNET", STARKNET_POP_FACTORY_CONTRACT),
};
