import { describe, expect, test } from "bun:test";
import { shortString } from "starknet";
import type { CallContract } from "./call.js";
import { readTokenUri } from "./tokenUri.js";

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

function chain(answers: Record<string, string[] | Error | (() => string[] | Error)>) {
  const seen: Array<{ entrypoint: string; calldata: string[] }> = [];
  const call: CallContract = async (_address, entrypoint, calldata) => {
    seen.push({ entrypoint, calldata });
    const entry = answers[entrypoint];
    const answer = typeof entry === "function" ? entry() : entry;
    if (!answer) throw refusal();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, seen, entrypoints: () => seen.map((s) => s.entrypoint) };
}

const own721 = { standard: "ERC721" as const, service: "mip-erc721" };
const own1155 = { standard: "ERC1155" as const, service: "mip-erc1155" };

describe("readTokenUri: own collections", () => {
  test("an ERC721 collection is read through token_uri only, with the token id as a u256", async () => {
    const { call, seen } = chain({ token_uri: byteArrayFelts("ipfs://cid/1.json") });
    expect(await readTokenUri(call, "0xown721", "1", own721)).toBe("ipfs://cid/1.json");
    expect(seen).toEqual([{ entrypoint: "token_uri", calldata: ["1", "0"] }]);
  });

  test("an ERC1155 collection is read through uri and {id} is replaced by the padded hex id", async () => {
    const { call } = chain({ uri: byteArrayFelts("https://x.test/{id}.json") });
    expect(await readTokenUri(call, "0xown1155", "26", own1155)).toBe(`https://x.test/${"1a".padStart(64, "0")}.json`);
  });

  test("a refusing own collection answers null without probing other entrypoints", async () => {
    const { call, entrypoints } = chain({});
    expect(await readTokenUri(call, "0xownrefuses", "1", own721)).toBeNull();
    expect(entrypoints()).toEqual(["token_uri"]);
  });

  test("a transport failure is thrown", async () => {
    const { call } = chain({ token_uri: new Error("fetch failed") });
    await expect(readTokenUri(call, "0xowndown", "1", own721)).rejects.toThrow("fetch failed");
  });
});

describe("readTokenUri: other contracts", () => {
  test("the camelCase entrypoint is tried after token_uri", async () => {
    const { call, entrypoints } = chain({ tokenURI: byteArrayFelts("https://x.test/a.json") });
    expect(await readTokenUri(call, "0xcamel", "1", null)).toBe("https://x.test/a.json");
    expect(entrypoints()).toEqual(["token_uri", "tokenURI"]);
  });

  test("a legacy felt-array answer is decoded", async () => {
    const part = "https://x.test/";
    const { call } = chain({ token_uri: ["0x2", shortString.encodeShortString(part), shortString.encodeShortString("1.json")] });
    expect(await readTokenUri(call, "0xlegacy", "1", { standard: null, service: "external-x" })).toBe(`${part}1.json`);
  });

  test("an entrypoint that answers with nothing readable moves on", async () => {
    const { call, entrypoints } = chain({ token_uri: ["0x0", "0x0", "0x0"], tokenURI: byteArrayFelts("https://x.test/b.json") });
    expect(await readTokenUri(call, "0xempty", "1", null)).toBe("https://x.test/b.json");
    expect(entrypoints()).toEqual(["token_uri", "tokenURI"]);
  });

  test("the entrypoint that worked is remembered, so the next read goes straight to it", async () => {
    const { call, entrypoints } = chain({ uri: byteArrayFelts("https://x.test/{id}.json") });
    await readTokenUri(call, "0xremember", "1", null);
    await readTokenUri(call, "0xremember", "2", null);
    expect(entrypoints()).toEqual(["token_uri", "tokenURI", "uri", "uri"]);
  });

  test("a remembered entrypoint that stops answering is dropped and probing starts over", async () => {
    let answering = true;
    const { call, entrypoints } = chain({
      uri: () => (answering ? byteArrayFelts("https://x.test/a") : (undefined as never)),
      tokenURI: () => (answering ? (undefined as never) : byteArrayFelts("https://x.test/moved")),
    });
    await readTokenUri(call, "0xdrops", "1", null);
    answering = false;
    expect(await readTokenUri(call, "0xdrops", "1", null)).toBe("https://x.test/moved");
    expect(entrypoints().slice(-3)).toEqual(["uri", "token_uri", "tokenURI"]);
  });

  test("nothing answering is null", async () => {
    const { call } = chain({});
    expect(await readTokenUri(call, "0xnone", "1", null)).toBeNull();
  });

  test("a transport failure while probing is thrown", async () => {
    const { call } = chain({ token_uri: new Error("fetch failed") });
    await expect(readTokenUri(call, "0xprobedown", "1", null)).rejects.toThrow("fetch failed");
  });
});
