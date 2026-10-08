import { resolveRecipientWallets, type RecipientWallet } from "../../../utils/recipientWallets.js";
import {
  productionProvisioningDeps,
  registerProvisioning,
  type RegisterInput,
  type RegisterResult,
} from "../../../api/routes/business-provisioning.js";

export interface DataTokenizationGuestDeps {
  resolveWallets(guests: string[]): Promise<RecipientWallet[]>;
  registerWallet(input: RegisterInput): Promise<RegisterResult>;
}

export const productionDataTokenizationGuestDeps: DataTokenizationGuestDeps = {
  resolveWallets: (guests) => resolveRecipientWallets("STARKNET", guests),
  registerWallet: (input) => registerProvisioning(productionProvisioningDeps, input),
};
