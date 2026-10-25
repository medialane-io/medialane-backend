import { describe, expect, test } from "bun:test";
import { byteArray, num, shortString } from "starknet";
import { callEither, readText, type CallContract } from "./call.js";

const refusal = (code: number) => Object.assign(new Error(`contract error ${code}`), { code });

function fake(answers: Record<string, string[] | Error>): { call: CallContract; seen: string[] } {
  const seen: string[] = [];
  const call: CallContract = async (_address, entrypoint) => {
    seen.push(entrypoint);
    const answer = answers[entrypoint];
    if (!answer) throw refusal(21);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, seen };
}

describe("callEither", () => {
  test("the first entrypoint that answers wins", async () => {
    const { call, seen } = fake({ token_uri: ["0x1"] });
    expect(await callEither(call, "0xa", ["token_uri", "tokenURI"], [])).toEqual(["0x1"]);
    expect(seen).toEqual(["token_uri"]);
  });

  test.each([20, 21, 40])("a contract refusal with code %d moves on to the next entrypoint", async (code) => {
    const { call, seen } = fake({ token_uri: refusal(code), tokenURI: ["0x2"] });
    expect(await callEither(call, "0xa", ["token_uri", "tokenURI"], [])).toEqual(["0x2"]);
    expect(seen).toEqual(["token_uri", "tokenURI"]);
  });

  test("every entrypoint refused gives null", async () => {
    const { call } = fake({});
    expect(await callEither(call, "0xa", ["token_uri", "tokenURI", "uri"], [])).toBeNull();
  });

  test("a transport failure is thrown, not treated as a refusal", async () => {
    const { call, seen } = fake({ token_uri: new Error("fetch failed"), tokenURI: ["0x2"] });
    await expect(callEither(call, "0xa", ["token_uri", "tokenURI"], [])).rejects.toThrow("fetch failed");
    expect(seen).toEqual(["token_uri"]);
  });
});

describe("readText", () => {
  test("reads a ByteArray answer as text", async () => {
    const ba = byteArray.byteArrayFromString("https://example.test/1.json");
    const felts = [num.toHex(ba.data.length), ...ba.data.map((d) => num.toHex(d as never)), num.toHex(ba.pending_word as never), num.toHex(ba.pending_word_len)];
    const { call } = fake({ token_uri: felts });
    expect(await readText(call, "0xa", ["token_uri"], [])).toBe("https://example.test/1.json");
  });

  test("a short-string answer is read as text", async () => {
    const { call } = fake({ name: [shortString.encodeShortString("Legacy")] });
    expect(await readText(call, "0xa", ["name"], [])).toBe("Legacy");
  });

  test("no entrypoint answering is null", async () => {
    const { call } = fake({});
    expect(await readText(call, "0xa", ["name"], [])).toBeNull();
  });
});
