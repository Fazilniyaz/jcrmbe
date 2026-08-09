import { Router } from "express";
import { ok } from "../../lib/http";
import { requireAuth } from "../../middleware/auth";
import { COUNTRIES } from "../../lib/countries";

/*
 * Static lookup data the UI needs to render a form.
 *
 * Served rather than duplicated in the frontend bundle so there is exactly one
 * country→currency table in the system. If the frontend carried its own copy,
 * the two would drift and a dropdown would eventually offer a pairing the
 * server rejects.
 *
 * Authenticated — not because the list is sensitive, but because there is no
 * reason to leave an unauthenticated endpoint on the API for it.
 */
export const referenceRouter = Router();

referenceRouter.use(requireAuth);

referenceRouter.get("/countries", (_req, res) => {
  // Immutable for the life of a deploy; let the browser keep it for a day.
  res.setHeader("Cache-Control", "private, max-age=86400");
  ok(res, COUNTRIES);
});
