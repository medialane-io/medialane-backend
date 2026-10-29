import { describe, expect, test } from "bun:test";
import { ec, typedData as starknetTypedData, type TypedData } from "starknet";
import { computeOwnerGuid, signWithPrivateKey, type GuardianInfo } from "@medialane/sdk/starknet";
import { cosign, GuardianUnavailableError, type CosignDeps } from "./guardianCosign.js";
import { guardianKeyWith } from "./guardianKey.js";

const SECRET = "g".repeat(64);
const WALLET = "0x" + "1".padStart(64, "0");

const data: TypedData = {
  domain: { name: "Test", version: "1", chainId: "SN_MAIN", revision: "1" },
  primaryType: "Message",
  types: {
    StarknetDomain: [
      { name: "name", type: "shortstring" },
      { name: "version", type: "shortstring" },
      { name: "chainId", type: "shortstring" },
      { name: "revision", type: "shortstring" },
    ],
    Message: [{ name: "value", type: "felt" }],
  },
  message: { value: "1" },
};
const hash = starknetTypedData.getMessageHash(data, WALLET);

const keyPair = () => {
  const privateKey = "0x" + Array.from(ec.starkCurve.utils.randomPrivateKey()).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { privateKey, publicKey: ec.starkCurve.getStarkKey(privateKey) };
};
const asSigner = (publicKey: string): GuardianInfo => ({ type: "Starknet", guid: computeOwnerGuid(publicKey), storedValue: publicKey });
const valid = (sig: string[], pub: string, h = hash) => {
  const signature = new ec.starkCurve.Signature(BigInt(sig[0]!), BigInt(sig[1]!));
  const x = BigInt(pub).toString(16).padStart(64, "0");
  return ["02", "03"].some((prefix) => ec.starkCurve.verify(signature, h, prefix + x));
};

const owner = keyPair();
const owner2 = keyPair();
const ours = guardianKeyWith(SECRET, WALLET);
const ownerSignature = signWithPrivateKey(owner.privateKey, hash);
const owner2Signature = signWithPrivateKey(owner2.privateKey, hash);

function deps(over: Partial<CosignDeps> & { guardians?: GuardianInfo[]; owners?: GuardianInfo[] } = {}): CosignDeps & { reads: number } {
  const state = { reads: 0 };
  return {
    secret: SECRET,
    guardiansOf: async () => { state.reads += 1; return over.guardians ?? []; },
    ownersOf: async () => { state.reads += 1; return over.owners ?? [asSigner(owner.publicKey)]; },
    ...over,
    get reads() { return state.reads; },
  } as CosignDeps & { reads: number };
}

describe("a wallet without a Medialane guardian", () => {
  test("keeps the owner's signature exactly as it is", async () => {
    const d = deps({ guardians: [] });
    expect(await cosign(d, WALLET, data, ownerSignature)).toEqual(ownerSignature);
  });

  test("keeps it when the wallet's guardian is someone else's", async () => {
    const d = deps({ guardians: [asSigner(keyPair().publicKey)] });
    expect(await cosign(d, WALLET, data, ownerSignature)).toEqual(ownerSignature);
  });
});

describe("when nothing is configured or readable", () => {
  test("without a guardian secret it reads nothing and changes nothing", async () => {
    const d = deps({ secret: "" });
    expect(await cosign(d, WALLET, data, ownerSignature)).toEqual(ownerSignature);
    expect(d.reads).toBe(0);
  });

  test("a failed guardian read throws GuardianUnavailableError", async () => {
    const d = deps({ guardiansOf: async () => { throw new Error("rpc down"); } });
    await expect(cosign(d, WALLET, data, ownerSignature)).rejects.toBeInstanceOf(GuardianUnavailableError);
  });

  test("a failed owner read throws GuardianUnavailableError", async () => {
    const d = deps({ guardians: [asSigner(ours.publicKey)], ownersOf: async () => { throw new Error("rpc down"); } });
    await expect(cosign(d, WALLET, data, ownerSignature)).rejects.toBeInstanceOf(GuardianUnavailableError);
  });

  test("a signature that is not the owner's short form is passed through", async () => {
    const d = deps({ guardians: [asSigner(ours.publicKey)] });
    const full = ["0x2", "0x0", "0x1", "0x2", "0x3", "0x0", "0x4", "0x5", "0x6"];
    expect(await cosign(d, WALLET, data, full)).toEqual(full);
  });
});

describe("a wallet with our guardian and one owner", () => {
  test("gets the short four-value signature, with a guardian signature that verifies", async () => {
    const d = deps({ guardians: [asSigner(ours.publicKey)] });
    const sig = await cosign(d, WALLET, data, ownerSignature);
    expect(sig).toHaveLength(4);
    expect(sig.slice(0, 2)).toEqual(ownerSignature);
    expect(valid(sig.slice(2), ours.publicKey)).toBe(true);
  });
});

describe("a wallet with our guardian and several owners", () => {
  const owners = [asSigner(owner.publicKey), asSigner(owner2.publicKey)];

  test("gets the full form naming the owner who signed", async () => {
    const d = deps({ guardians: [asSigner(ours.publicKey)], owners });
    const sig = await cosign(d, WALLET, data, owner2Signature);
    expect(sig.slice(0, 3)).toEqual(["0x2", "0x0", owner2.publicKey]);
    expect(sig.slice(3, 5)).toEqual(owner2Signature);
    expect(sig.slice(5, 7)).toEqual(["0x0", ours.publicKey]);
    expect(valid(sig.slice(7), ours.publicKey)).toBe(true);
  });

  test("is left alone when no owner of the wallet made the signature", async () => {
    const d = deps({ guardians: [asSigner(ours.publicKey)], owners });
    const stranger = signWithPrivateKey(keyPair().privateKey, hash);
    expect(await cosign(d, WALLET, data, stranger)).toEqual(stranger);
  });
});

describe("the guardian key", () => {
  test("is different for every wallet and every secret, and is never the owner's", () => {
    const other = "0x" + "2".padStart(64, "0");
    expect(guardianKeyWith(SECRET, other).publicKey).not.toBe(ours.publicKey);
    expect(guardianKeyWith("h".repeat(64), WALLET).publicKey).not.toBe(ours.publicKey);
  });

  test("refuses a missing or short secret", () => {
    expect(() => guardianKeyWith("", WALLET)).toThrow("GUARDIAN_SECRET is not configured");
    expect(() => guardianKeyWith("short", WALLET)).toThrow("GUARDIAN_SECRET is not configured");
  });
});
