import { Hono } from "hono";

const remixOffers = new Hono();

// GET /v1/remix-offers?role=creator|requester&status=&page=&limit=
// Temporary local stub until persistent remix-offer storage is added in backend.
remixOffers.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  return c.json({ data: [], meta: { page, limit, total: 0 } });
});

// Mutations are not implemented in this backend branch yet.
const notImplemented = (c: any) =>
  c.json(
    {
      error:
        "Remix offer mutations are not implemented in this backend branch yet.",
    },
    501
  );

remixOffers.post("/", notImplemented);
remixOffers.post("/auto", notImplemented);
remixOffers.post("/self/confirm", notImplemented);
remixOffers.post("/:id/confirm", notImplemented);
remixOffers.post("/:id/reject", notImplemented);

export default remixOffers;
