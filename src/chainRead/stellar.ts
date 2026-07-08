import { Contract, TransactionBuilder, nativeToScVal, scValToNative, rpc } from "@stellar/stellar-sdk";
import type { Chain } from "@prisma/client";
import { getCoordinates } from "@medialane/sdk";
import { env } from "../config/env.js";

/** Stellar (Soroban) read adapter — simulated view calls on the collection
 *  contracts (owner_of / owner). On-demand, read-only. */

const PASSPHRASE = "Public Global Stellar Network ; September 2015";
const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function server(): rpc.Server {
  const url = env.STELLAR_RPC_URL ?? (getCoordinates("STELLAR") as { rpcUrl: string }).rpcUrl;
  return new rpc.Server(url);
}

async function view(contractId: string, method: string, args: ReturnType<typeof nativeToScVal>[]): Promise<unknown> {
  const s = server();
  const account = await s.getAccount(SIM_SOURCE);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) return scValToNative(sim.result.retval);
  throw new Error(`stellar view ${method} failed`);
}

export async function stellarHoldsToken(
  _chain: Chain,
  contract: string,
  owner: string,
  knownTokenIds?: string[],
): Promise<boolean> {
  if (!knownTokenIds || knownTokenIds.length === 0) return false;
  for (const id of knownTokenIds.slice(0, 50)) {
    try {
      const holder = await view(contract, "owner_of", [nativeToScVal(Number(id), { type: "u32" })]);
      if (holder === owner) return true;
    } catch {
      // nonexistent token — keep scanning
    }
  }
  return false;
}

export async function stellarCollectionOwner(_chain: Chain, contract: string): Promise<string> {
  return (await view(contract, "owner", [])) as string;
}
