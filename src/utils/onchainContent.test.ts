import { expect, test } from "bun:test";
import { storedImage, storedTokenUri } from "./onchainContent.js";

const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";

test("a token URI is stored only when it is a link", () => {
  expect(storedTokenUri("ipfs://bafy/1.json")).toBe("ipfs://bafy/1.json");
  expect(storedTokenUri("data:application/json;base64,e30=")).toBeNull();
  expect(storedTokenUri(null)).toBeNull();
});

test("an image link is stored as it is", () => {
  expect(storedImage("ipfs://bafy/img.png")).toBe("ipfs://bafy/img.png");
});

test("an inline image is stored with the token", () => {
  expect(storedImage(`data:image/svg+xml;utf8,${svg}`)).toBe(`data:image/svg+xml;utf8,${svg}`);
});

test("inline content that is not an image is not stored", () => {
  expect(storedImage("data:text/html;base64,PHA+")).toBeNull();
  expect(storedImage(undefined)).toBeNull();
  expect(storedImage("")).toBeNull();
});
