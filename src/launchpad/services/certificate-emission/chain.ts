import { STARKNET_POP_FACTORY_CONTRACT } from "@medialane/sdk";
import { resolveRecipientWallets, type RecipientWallet } from "../../../utils/recipientWallets.js";
import { callRpc, normalizeAddress } from "../../../utils/starknet.js";
import {
  productionProvisioningDeps,
  registerProvisioning,
  type RegisterInput,
  type RegisterResult,
} from "../../../api/routes/business-provisioning.js";

export interface CertificateEmissionDeps {
  resolveWallets(guests: string[]): Promise<RecipientWallet[]>;
  registerWallet(input: RegisterInput): Promise<RegisterResult>;
  popFactory(): string;
  /** The collection's organizer, read from chain. */
  organizerOf(collection: string): Promise<string>;
}

export const productionCertificateEmissionDeps: CertificateEmissionDeps = {
  resolveWallets: (guests) => resolveRecipientWallets("STARKNET", guests),
  registerWallet: (input) => registerProvisioning(productionProvisioningDeps, input),
  popFactory: () => STARKNET_POP_FACTORY_CONTRACT,
  async organizerOf(collection) {
    const [organizer] = await callRpc((provider) =>
      provider.callContract({ contractAddress: collection, entrypoint: "organizer", calldata: [] }),
    );
    return normalizeAddress("STARKNET", organizer ?? "0x0");
  },
};
