import { describe, expect, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";
import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";
import { createSponsorAuthorizer, SPONSORED_REQUESTS_PER_MINUTE } from "./sponsor-authorizer.js";

const WALLET = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_WALLET = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";

function authorizerFor(owners: Record<string, string>) {
  const lookups: string[] = [];
  const db = {
    identity: {
      findUnique: async ({ where }: { where: { chain_address: { address: string } } }) => {
        lookups.push(where.chain_address.address);
        const accountId = owners[where.chain_address.address];
        return accountId ? { accountId } : null;
      },
    },
  } as never;
  const authorizer = createSponsorAuthorizer(db, {
    verifySession: (raw) => (raw.startsWith("session:") ? raw.slice("session:".length) : null),
    store: new InMemoryRateLimitStore(),
  });
  return { authorizer, lookups };
}

const owners = { [normalizeAddress("STARKNET", WALLET)]: "acct-user" };

describe("who may spend sponsored gas", () => {
  test("a request with no session and no account behind its key is refused", async () => {
    const { authorizer } = authorizerFor(owners);
    expect(await authorizer.authorize({ userAddress: WALLET })).toEqual({ status: 401, error: "Sign in to use sponsored transactions" });
  });

  test("a session that does not verify is refused even when the key has an account", async () => {
    const { authorizer } = authorizerFor(owners);
    const denial = await authorizer.authorize({ sessionToken: "forged", apiKeyAccountId: "acct-user", userAddress: WALLET });
    expect(denial?.status).toBe(401);
  });

  test("a signed-in account may sponsor its own wallet", async () => {
    const { authorizer } = authorizerFor(owners);
    expect(await authorizer.authorize({ sessionToken: "session:acct-user", apiKeyAccountId: "acct-app", userAddress: WALLET })).toBeNull();
  });

  test("a signed-in account may not sponsor someone else's wallet", async () => {
    const { authorizer } = authorizerFor(owners);
    const denial = await authorizer.authorize({ sessionToken: "session:acct-attacker", userAddress: WALLET });
    expect(denial).toEqual({ status: 403, error: "This wallet does not belong to the signed-in account" });
  });

  test("a wallet linked to no account is never sponsored", async () => {
    const { authorizer } = authorizerFor(owners);
    const denial = await authorizer.authorize({ sessionToken: "session:acct-user", userAddress: OTHER_WALLET });
    expect(denial?.status).toBe(403);
  });

  test("an API client without a session sponsors only wallets of its own account", async () => {
    const { authorizer } = authorizerFor(owners);
    expect(await authorizer.authorize({ apiKeyAccountId: "acct-user", userAddress: WALLET })).toBeNull();
    expect((await authorizer.authorize({ apiKeyAccountId: "acct-app", userAddress: WALLET }))?.status).toBe(403);
  });

  test("the wallet is looked up in its stored address form", async () => {
    const { authorizer, lookups } = authorizerFor(owners);
    await authorizer.authorize({ sessionToken: "session:acct-user", userAddress: "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" });
    expect(lookups).toEqual([normalizeAddress("STARKNET", WALLET)]);
  });

  test("an account that sponsors too much in a minute is slowed down", async () => {
    const { authorizer } = authorizerFor(owners);
    for (let i = 0; i < SPONSORED_REQUESTS_PER_MINUTE; i++) {
      expect(await authorizer.authorize({ sessionToken: "session:acct-user", userAddress: WALLET })).toBeNull();
    }
    expect((await authorizer.authorize({ sessionToken: "session:acct-user", userAddress: WALLET }))?.status).toBe(429);
  });
});
