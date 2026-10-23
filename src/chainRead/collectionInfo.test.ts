import { describe, expect, test } from "bun:test";
import { shortString } from "starknet";
import type { CallContract } from "./call.js";
import { detectStandard, readCollectionInfo, readOwner } from "./collectionInfo.js";

const toHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") || "0"}`;

function byteArrayFelts(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const words: string[] = [];
  let i = 0;
  for (; i + 31 <= bytes.length; i += 31) words.push(toHex(bytes.slice(i, i + 31)));
  const pending = bytes.slice(i);
  return [`0x${words.length.toString(16)}`, ...words, toHex(pending), `0x${pending.length.toString(16)}`];
}

const refusal = (code = 21) => Object.assign(new Error(`contract error ${code}`), { code });

function chain(answers: Record<string, string[] | Error | ((calldata: string[]) => string[] | Error | undefined)>) {
  const seen: Array<{ entrypoint: string; calldata: string[] }> = [];
  const call: CallContract = async (_address, entrypoint, calldata) => {
    seen.push({ entrypoint, calldata });
    const entry = answers[entrypoint];
    const answer = typeof entry === "function" ? entry(calldata) : entry;
    if (!answer) throw refusal();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, seen };
}

const OWNER = `0x${"0".repeat(60)}abcd`;

describe("readOwner", () => {
  test("is the owner() answer, normalized", async () => {
    expect(await readOwner(chain({ owner: ["0xabcd"] }).call, "0x1")).toBe(OWNER);
  });

  test("a zero owner is no owner", async () => {
    expect(await readOwner(chain({ owner: ["0x0"] }).call, "0x1")).toBeNull();
  });

  test("a contract without owner() is null", async () => {
    expect(await readOwner(chain({}).call, "0x1")).toBeNull();
  });

  test("a transport failure is thrown", async () => {
    await expect(readOwner(chain({ owner: new Error("fetch failed") }).call, "0x1")).rejects.toThrow("fetch failed");
  });
});

const SRC5_1155 = "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52";
const ERC165_1155 = "0xd9b67a26";
const SRC5_721 = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16ea3175bd943";
const ERC165_721 = "0x80ac58cd";

const supports = (...ids: string[]) => (calldata: string[]) => ["0x" + (ids.includes(calldata[0]!) ? "1" : "0")];

describe("detectStandard", () => {
  test("ERC1155 is checked before ERC721", async () => {
    const { call, seen } = chain({ supports_interface: supports(SRC5_1155, SRC5_721) });
    expect(await detectStandard(call, "0x1")).toBe("ERC1155");
    expect(seen[0]?.calldata).toEqual([SRC5_1155]);
  });

  test("the second 1155 id and the 721 ids are tried in order", async () => {
    expect(await detectStandard(chain({ supports_interface: supports(ERC165_1155) }).call, "0x1")).toBe("ERC1155");
    expect(await detectStandard(chain({ supports_interface: supports(SRC5_721) }).call, "0x1")).toBe("ERC721");
    expect(await detectStandard(chain({ supports_interface: supports(ERC165_721) }).call, "0x1")).toBe("ERC721");
  });

  test("the camelCase entrypoint is used when snake_case is refused", async () => {
    expect(await detectStandard(chain({ supportsInterface: supports(SRC5_721) }).call, "0x1")).toBe("ERC721");
  });

  test("a contract that supports neither is null, and one with no supports_interface is null", async () => {
    expect(await detectStandard(chain({ supports_interface: supports() }).call, "0x1")).toBeNull();
    expect(await detectStandard(chain({}).call, "0x1")).toBeNull();
  });

  test("a transport failure is thrown", async () => {
    await expect(detectStandard(chain({ supports_interface: new Error("fetch failed") }).call, "0x1")).rejects.toThrow("fetch failed");
  });
});

describe("readCollectionInfo", () => {
  test("reads name, symbol and base_uri as ByteArrays", async () => {
    const { call } = chain({ name: byteArrayFelts("Gallery"), symbol: byteArrayFelts("GAL"), base_uri: byteArrayFelts("ipfs://cid/") });
    expect(await readCollectionInfo(call, "0x1", { legacy: false })).toEqual({ name: "Gallery", symbol: "GAL", baseUri: "ipfs://cid/" });
  });

  test("legacy short strings are read only when allowed and the ByteArray read found neither name nor symbol", async () => {
    const answers = { name: [shortString.encodeShortString("Old")], symbol: [shortString.encodeShortString("OLD")] };
    expect(await readCollectionInfo(chain(answers).call, "0x1", { legacy: true })).toEqual({ name: "Old", symbol: "OLD", baseUri: "" });
    expect(await readCollectionInfo(chain(answers).call, "0x1", { legacy: false })).toEqual({ name: "", symbol: "", baseUri: "" });
  });

  test("when the ByteArray read found a name, a legacy-only symbol is not fetched", async () => {
    const { call } = chain({ name: byteArrayFelts("Gallery"), symbol: [shortString.encodeShortString("OLD")] });
    expect(await readCollectionInfo(call, "0x1", { legacy: true })).toEqual({ name: "Gallery", symbol: "", baseUri: "" });
  });

  test("a base_uri alone does not count as an answer when legacy reads are off", async () => {
    const { call } = chain({ base_uri: byteArrayFelts("ipfs://cid/") });
    expect(await readCollectionInfo(call, "0x1", { legacy: false })).toEqual({ name: "", symbol: "", baseUri: "" });
  });

  test("a contract that answers nothing gives empty strings", async () => {
    expect(await readCollectionInfo(chain({}).call, "0x1", { legacy: true })).toEqual({ name: "", symbol: "", baseUri: "" });
  });

  test("a transport failure is thrown", async () => {
    await expect(readCollectionInfo(chain({ name: new Error("fetch failed") }).call, "0x1", { legacy: false })).rejects.toThrow("fetch failed");
  });
});
