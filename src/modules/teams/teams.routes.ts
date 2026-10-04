import { Router } from "express";
import { created, ok } from "../../lib/http";
import { body, objectId, params, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import { z } from "zod";
import {
  createTeamSchema,
  updateTeamSchema,
  type CreateTeamInput,
  type UpdateTeamInput,
} from "./teams.schema";
import { createTeam, deleteTeam, listTeams, updateTeam } from "./teams.service";

/*
 * Teams.
 *
 * Reading is open to anyone with the module — a picker on the project and task
 * forms needs the list. Writing is a lead's job and the service enforces that,
 * on top of the module guard's own view/edit split.
 */
export const teamsRouter = Router();

teamsRouter.use(requireAuth, requireUser, requireModule("teams"));

const idParam = z.object({ id: objectId });

teamsRouter.get("/", async (req, res) => {
  ok(res, await listTeams(actor(req)));
});

teamsRouter.post("/", validate({ body: createTeamSchema }), async (req, res) => {
  created(res, await createTeam(actor(req), body<CreateTeamInput>(req)));
});

teamsRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateTeamSchema }),
  async (req, res) => {
    ok(res, await updateTeam(actor(req), params<{ id: string }>(req).id, body<UpdateTeamInput>(req)));
  },
);

teamsRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await deleteTeam(actor(req), params<{ id: string }>(req).id));
});
