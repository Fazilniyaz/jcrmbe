import { Router } from "express";
import { z } from "zod";
import { created, ok } from "../../lib/http";
import { body, objectId, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  assignTasksSchema,
  createSprintSchema,
  listSprintsSchema,
  updateSprintSchema,
  type AssignTasksInput,
  type CreateSprintInput,
  type ListSprintsQuery,
  type UpdateSprintInput,
} from "./sprints.schema";
import {
  assignTasks,
  createSprint,
  deleteSprint,
  listSprints,
  updateSprint,
} from "./sprints.service";

/*
 * Sprints hang off the PROJECTS module rather than having one of their own.
 *
 * A sprint is how a project's work is sliced, so "can plan sprints" is already
 * answered by "can edit projects" — a separate grant would be a second switch
 * that has to be remembered every time the first one is flipped, and a sidebar
 * entry for something that is never opened on its own.
 *
 * The method-based level check in requireModule does the rest: reading a lane
 * needs `view`, moving a task between lanes needs `edit`.
 */
export const sprintsRouter = Router();

sprintsRouter.use(requireAuth, requireUser, requireModule("projects"));

const idParam = z.object({ id: objectId });

sprintsRouter.get("/", validate({ query: listSprintsSchema }), async (req, res) => {
  ok(res, await listSprints(actor(req), query<ListSprintsQuery>(req)));
});

sprintsRouter.post("/", validate({ body: createSprintSchema }), async (req, res) => {
  created(res, await createSprint(actor(req), body<CreateSprintInput>(req)));
});

/*
 * Before /:id, deliberately. Express matches in order, so a route registered
 * after the parameterised one would be swallowed by it — "assign" would arrive
 * as an :id that fails ObjectId validation.
 */
sprintsRouter.post("/assign", validate({ body: assignTasksSchema }), async (req, res) => {
  ok(res, await assignTasks(actor(req), body<AssignTasksInput>(req)));
});

sprintsRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateSprintSchema }),
  async (req, res) => {
    ok(
      res,
      await updateSprint(actor(req), params<{ id: string }>(req).id, body<UpdateSprintInput>(req)),
    );
  },
);

sprintsRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await deleteSprint(actor(req), params<{ id: string }>(req).id));
});
