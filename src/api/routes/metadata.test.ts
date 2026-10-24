import { test, expect } from "bun:test";
import { buildDirectoryPinForm } from "./metadata";

test("buildDirectoryPinForm names every file under the given folder prefix", () => {
  const form = buildDirectoryPinForm(
    [
      { name: "1", content: { name: "Item 1" } },
      { name: "collection.json", content: { name: "My Drop" } },
    ],
    "dir",
  );

  const entries = form.getAll("file") as File[];
  expect(entries.map((f) => f.name)).toEqual(["dir/1", "dir/collection.json"]);
});

test("buildDirectoryPinForm sets wrapWithDirectory: false — Pinata rejects flat multi-file pins otherwise", () => {
  const form = buildDirectoryPinForm([{ name: "1", content: {} }], "dir");
  const options = JSON.parse(form.get("pinataOptions") as string);
  expect(options.wrapWithDirectory).toBe(false);
});

test("buildDirectoryPinForm serializes each file's content as JSON", async () => {
  const form = buildDirectoryPinForm(
    [{ name: "1", content: { name: "Item 1", attributes: [{ trait_type: "License", value: "CC0" }] } }],
    "dir",
  );
  const entries = form.getAll("file") as File[];
  const text = await entries[0].text();
  expect(JSON.parse(text)).toEqual({ name: "Item 1", attributes: [{ trait_type: "License", value: "CC0" }] });
});
