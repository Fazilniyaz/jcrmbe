import { Router } from "express";
import { z } from "zod";
import { created, noContent, ok, pageMeta } from "../../lib/http";
import { body, idParam, objectId, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  createTaskSchema,
  listTasksSchema,
  qcReviewSchema,
  scoreItemSchema,
  setAssigneesSchema,
  setStateSchema,
  updateTaskSchema,
  type CreateTaskInput,
  type ListTasksQuery,
  type QcReviewInput,
  type UpdateTaskInput,
} from "./tasks.schema";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  scoreChecklistItem,
  submitQcReview,
  updateTask,
} from "./tasks.service";

export const tasksRouter = Router();

tasksRouter.use(requireAuth, requireUser, requireModule("tasks"));

tasksRouter.get("/", validate({ query: listTasksSchema }), async (req, res) => {
  const q = query<ListTasksQuery>(req);
  const { rows, total } = await listTasks(actor(req), q);
  ok(res, rows, pageMeta(total, q.page, q.perPage));
});

tasksRouter.post("/", validate({ body: createTaskSchema }), async (req, res) => {
  const task = await createTask(actor(req), body<CreateTaskInput>(req));
  created(res, task, `/api/v1/tasks/${task.id}`);
});

tasksRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await getTask(actor(req), params<{ id: string }>(req).id));
});

tasksRouter.patch("/:id", validate({ params: idParam, body: updateTaskSchema }), async (req, res) => {
  ok(res, await updateTask(actor(req), params<{ id: string }>(req).id, body<UpdateTaskInput>(req)));
});

tasksRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  await deleteTask(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});

/** Convenience wrappers over PATCH — the board and the row menu use these. */
tasksRouter.patch("/:id/state", validate({ params: idParam, body: setStateSchema }), async (req, res) => {
  const input = body<{ state: CreateTaskInput["state"]; note?: string }>(req);
  ok(res, await updateTask(actor(req), params<{ id: string }>(req).id, input));
});

tasksRouter.patch(
  "/:id/assignees",
  validate({ params: idParam, body: setAssigneesSchema }),
  async (req, res) => {
    const input = body<{ assigneeIds: string[]; note?: string }>(req);
    ok(res, await updateTask(actor(req), params<{ id: string }>(req).id, input));
  },
);

tasksRouter.patch(
  "/:id/checklist/:itemId",
  validate({
    params: z.object({ id: objectId, itemId: z.string().trim().min(1).max(64) }).strict(),
    body: scoreItemSchema,
  }),
  async (req, res) => {
    const { id, itemId } = params<{ id: string; itemId: string }>(req);
    const input = body<{ score?: number; done?: boolean }>(req);
    ok(res, await scoreChecklistItem(actor(req), id, itemId, input));
  },
);

/**
 * The QC verdict. Requires the Checklist module as well as Tasks — signing work
 * off is a distinct capability from working on it.
 */
tasksRouter.post(
  "/:id/qc-review",
  requireModule("checklist"),
  validate({ params: idParam, body: qcReviewSchema }),
  async (req, res) => {
    ok(res, await submitQcReview(actor(req), params<{ id: string }>(req).id, body<QcReviewInput>(req)));
  },
);
