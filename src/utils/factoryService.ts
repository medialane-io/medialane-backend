import { listServices } from "@medialane/sdk";
import { normalizeAddress } from "./starknet.js";
import type { ServiceId } from "@medialane/sdk";

const FALLBACK_SERVICE = "mip-erc721";

export function serviceForFactory(factoryAddress: string): ServiceId {
  const normalized = normalizeAddress("STARKNET", factoryAddress);
  for (const service of listServices()) {
    const address = service.onchain?.STARKNET?.factoryAddress;
    if (address && normalizeAddress("STARKNET", address) === normalized) {
      return service.id as ServiceId;
    }
  }
  return FALLBACK_SERVICE as ServiceId;
}
