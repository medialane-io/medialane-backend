import { resolveRecipientWallets, type RecipientWallet } from "../../../utils/recipientWallets.js";
import {
  productionProvisioningDeps,
  registerProvisioning,
  type RegisterInput,
  type RegisterResult,
} from "../../../api/routes/business-provisioning.js";

export interface CertificateEmissionDeps {
  resolveWallets(guests: string[]): Promise<RecipientWallet[]>;
  registerWallet(input: RegisterInput): Promise<RegisterResult>;
}

export const productionCertificateEmissionDeps: CertificateEmissionDeps = {
  resolveWallets: (guests) => resolveRecipientWallets("STARKNET", guests),
  registerWallet: (input) => registerProvisioning(productionProvisioningDeps, input),
};
