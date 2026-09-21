import { describe, expect, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";
import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";
import { createSponsorAuthorizer, SPONSORED_REQUESTS_PER_MINUTE } from "./sponsor-authorizer.js";

const WALLET = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_WALLET = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";

function authorizer() {
  return createSponsorAuthorizer({} as never, { store: new InMemoryRateLimitStore() });
}

describe("what sponsored gas asks of a caller", () => {
  test("a wallet is sponsored without a session, because the signature is what proves it", async () => {
    expect(await authorizer().authorize({ userAddress: WALLET })).toBeNull();
  });

  test("a deploy, which names no wallet yet, is sponsored too", async () => {
    expect(await authorizer().authorize({})).toBeNull();
  });

  test("an address that cannot be read is refused", async () => {
    expect(await authorizer().authorize({ userAddress: "not-an-address" })).toEqual({
      status: 400,
      error: "That wallet address could not be read",
      code: "invalid_request",
    });
  });

  test("the same wallet written differently shares one allowance", async () => {
    const auth = authorizer();
    const unpadded = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(normalizeAddress("STARKNET", unpadded)).toBe(WALLET);

    for (let i = 0; i < SPONSORED_REQUESTS_PER_MINUTE; i++) {
      expect(await auth.authorize({ userAddress: WALLET })).toBeNull();
    }
    expect(await auth.authorize({ userAddress: unpadded })).toMatchObject({ code: "rate_limited" });
  });
});

describe("how much one wallet may spend in a minute", () => {
  test("a wallet over its minute is slowed down", async () => {
    const auth = authorizer();
    for (let i = 0; i < SPONSORED_REQUESTS_PER_MINUTE; i++) {
      expect(await auth.authorize({ userAddress: WALLET })).toBeNull();
    }
    expect(await auth.authorize({ userAddress: WALLET })).toEqual({
      status: 429,
      error: "Too many sponsored transactions. Try again in a minute.",
      code: "rate_limited",
    });
  });

  test("one busy wallet does not slow another down", async () => {
    const auth = authorizer();
    for (let i = 0; i <= SPONSORED_REQUESTS_PER_MINUTE; i++) {
      await auth.authorize({ userAddress: WALLET });
    }
    expect(await auth.authorize({ userAddress: OTHER_WALLET })).toBeNull();
  });

  test("deploys carry their own allowance, apart from any wallet", async () => {
    const auth = authorizer();
    for (let i = 0; i <= SPONSORED_REQUESTS_PER_MINUTE; i++) {
      await auth.authorize({ userAddress: WALLET });
    }
    expect(await auth.authorize({})).toBeNull();
  });
});
