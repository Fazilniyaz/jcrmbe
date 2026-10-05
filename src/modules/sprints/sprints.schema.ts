import { z } from "zod";
import { objectId, optionalIsoDate, optionalText, text } from "../../middleware/validate";

/*
 * A sprint is a named window of work inside ONE project.
 *
 * `projectId` is required on create and absent from update on purpose: moving
 * a sprint between projects would orphan every task in it, so it is not an
 * edit — it is a delete and a create, which at least makes the consequence
 * visible.
 */

export const sprintStateEnum = z.enum(["planned", "active", "completed", "cancelled"]);

export const createSprintSchema = z
  .object({
    projectId: objectId,
    name: text(80),
    goal: optionalText(300),
    state: sprintStateEnum.default("planned"),
    tone: optionalText(20),
    startDate: optionalIsoDate,
    endDate: optionalIsoDate,
    /** Omitted means "put it after the project's last sprint". */
    order: z.number().optional(),
  })
  .strict();

export const updateSprintSchema = createSprintSchema
  .omit({ projectId: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listSprintsSchema = z
  .object({ projectId: objectId.optional() })
  .strict();

/**
 * Move tasks into (or out of) a sprint in one call.
 *
 * `sprintId: null` is how work goes back to the backlog, which is why the
 * field is nullable rather than optional — an omitted field would be
 * indistinguishable from "send it to the backlog".
 */
export const assignTasksSchema = z
  .object({
    taskIds: z.array(objectId).min(1).max(200),
    sprintId: objectId.nullable(),
  })
  .strict();

export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
export type ListSprintsQuery = z.infer<typeof listSprintsSchema>;
export type AssignTasksInput = z.infer<typeof assignTasksSchema>;
