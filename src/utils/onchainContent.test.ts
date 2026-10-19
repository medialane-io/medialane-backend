import { expect, test } from "bun:test";
import { decodeImageDataUri, storedImage, storedTokenUri } from "./onchainContent.js";

const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";

test("a token URI is stored only when it is a link", () => {
  expect(storedTokenUri("ipfs://bafy/1.json")).toBe("ipfs://bafy/1.json");
  expect(storedTokenUri("data:application/json;base64,e30=")).toBeNull();
  expect(storedTokenUri(null)).toBeNull();
});

test("an inline image is stored as the media URL of its token", () => {
  expect(storedImage("ipfs://bafy/img.png", "STARKNET", "0xc", "7")).toBe("ipfs://bafy/img.png");
  expect(storedImage(`data:image/svg+xml;utf8,${svg}`, "STARKNET", "0xc", "7")).toBe(
    "https://api.medialane.io/media/starknet/0xc/7/image",
  );
  expect(storedImage(undefined, "STARKNET", "0xc", "7")).toBeNull();
});

test("an inline image decodes from base64 or text, and only image types are accepted", () => {
  const b64 = decodeImageDataUri(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  expect(b64?.contentType).toBe("image/svg+xml");
  expect(Buffer.from(b64!.bytes).toString()).toBe(svg);
  const text = decodeImageDataUri(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  expect(Buffer.from(text!.bytes).toString()).toBe(svg);
  expect(decodeImageDataUri("data:text/html;base64,PHA+")).toBeNull();
  expect(decodeImageDataUri("https://example.com/a.png")).toBeNull();
});
