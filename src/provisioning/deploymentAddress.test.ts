import { expect, test } from "bun:test";
import { hash } from "starknet";
import { getCoordinates } from "@medialane/sdk";
import { ownerConstructorCalldata } from "@medialane/sdk/starknet";
import { provisioningKeyWith } from "../utils/provisioningKey.js";

test("the wallet address the backend records is the address its deployment class, salt and calldata produce", () => {
  const key = provisioningKeyWith("d".repeat(64), "acc-1");
  const classHash = getCoordinates("STARKNET").mediaWalletClassHash!;
  const deployed = hash.calculateContractAddressFromHash("0x0", classHash, ownerConstructorCalldata(key.publicKey), 0);
  expect(BigInt(deployed)).toBe(BigInt(key.walletAddress));
});
