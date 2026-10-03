import { Router } from "express";
import { ok } from "../../lib/http";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import { getPlayground } from "./playground.service";

/*
 * "Your Playground" — the office roster.
 *
 * Read-only by design: it shows who is here and how they are doing, and every
 * change to any of that belongs in the module that owns it (Employees,
 * Projects, Tasks). So there is one GET and nothing else.
 *
 * `requireModule("playground")` is the whole access story. No role lists the
 * slug in the registry's BY_ROLE table, so it resolves for a superAdmin (who
 * short-circuits to everything) or for someone a superAdmin granted it to.
 */
export const playgroundRouter = Router();

playgroundRouter.use(requireAuth, requireUser, requireModule("playground"));

playgroundRouter.get("/", async (req, res) => {
  ok(res, await getPlayground(actor(req)));
});
