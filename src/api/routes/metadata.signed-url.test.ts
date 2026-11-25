import { test, expect, mock } from "bun:test";

let failure = "plan limits reached";
mock.module("pinata", () => ({
  PinataSDK: class {
    upload = { public: { createSignedURL: async () => { throw new Error(failure); } } };
  },
}));

const { default: metadata } = await import("./metadata");

test("a refused upload carries a code clients can recognise, with the storage status kept", async () => {
  for (const [message, status] of [["plan limits reached", 403], ["socket closed", 500]] as const) {
    failure = message;
    const response = await metadata.request("/signed-url");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: "Uploads are temporarily unavailable. Please try again later. If the error persists, contact our support.",
      code: "uploads_unavailable",
    });
  }
});
