import { z } from "zod";
import { objectId, optionalIsoDate, optionalText, text, urlField } from "../../middleware/validate";

export const taskStateEnum = z.enum([
  "todo",
  "backlog",
  "inProgress",
  "inReview",
  "done",
  "blocked",
  "failed",
]);

export const qcVerdictEnum = z.enum(["Approved", "Corrections", "Error"]);
export const bugSeverityEnum = z.enum(["Critical", "Major", "Minor"]);

/**
 * One acceptance line.
 *
 * `score` and `points` are independent on purpose, exactly as the frontend has
 * it: score is how far along the line is, points is what it costs each assignee
 * if QC rejects it.
 */
export const checklistItemSchema = z
  .object({
    id: optionalText(64),
    label: text(300),
    score: z.number().min(0).max(1).default(0),
    points: z.number().int().min(1).max(100).default(1),
    done: z.boolean().optional(),
  })
  .strict();

export const createTaskSchema = z
  .object({
    title: text(200),
    description: optionalText(8000),
    taskCode: optionalText(32),
    /** At least one project — a task with none is unreachable. */
    projectIds: z.array(objectId).min(1, "Pick at least one project.").max(10),
    assigneeIds: z.array(objectId).max(20).default([]),
    reportToIds: z.array(objectId).max(20).default([]),
    state: taskStateEnum.default("todo"),
    /** 1 = do first, 5 = whenever. */
    priorityLevel: z.number().int().min(1).max(5).default(3),
    kraPoints: z.number().int().min(0).max(100).default(0),
    checklist: z.array(checklistItemSchema).max(100).default([]),
    startDate: optionalIsoDate,
    endDate: optionalIsoDate,
    dueDate: optionalIsoDate,
    prUrl: urlField.optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
    origin: z
      .object({
        kind: z.literal("qc-bug"),
        severity: bugSeverityEnum,
        foundIn: optionalText(200),
      })
      .strict()
      .optional(),
  })
  .strict();

export const updateTaskSchema = createTaskSchema
  .partial()
  .extend({
    /** Appended to the task's audit trail when present. */
    note: optionalText(500),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listTasksSchema = z
  .object({
    q: optionalText(120),
    state: taskStateEnum.optional(),
    projectId: objectId.optional(),
    assigneeId: objectId.optional(),
    /** "mine" = assigned to me; "review" = finished work QC hasn't cleared. */
    scope: z.enum(["all", "mine", "review", "bugs"]).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const setStateSchema = z
  .object({ state: taskStateEnum, note: optionalText(500) })
  .strict();

export const setAssigneesSchema = z
  .object({ assigneeIds: z.array(objectId).max(20), note: optionalText(500) })
  .strict();

export const scoreItemSchema = z
  .object({ score: z.number().min(0).max(1).optional(), done: z.boolean().optional() })
  .strict()
  .refine((v) => v.score !== undefined || v.done !== undefined, "Pass a score or done.");

/**
 * A QC verdict.
 *
 * `failedItemIds` are subtask ids — the points on those subtasks are what an
 * Error verdict costs. The client never sends the deduction itself; the server
 * computes it from the stored subtasks, so a tampered request cannot choose how
 * much KRA someone loses.
 *
 * Only Error requires something to be flagged, because only Error charges for
 * it. Corrections is a nudge — "look at this again" — and demanding a flagged
 * subtask before you could ask for one meant the two verdicts had the same
 * entry requirement despite having opposite consequences.
 */
export const qcReviewSchema = z
  .object({
    verdict: qcVerdictEnum,
    failedItemIds: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
    note: optionalText(1000),
  })
  .strict()
  .refine((v) => v.verdict !== "Error" || v.failedItemIds.length > 0, {
    message: "Flag at least one subtask to record an error — its points are what gets deducted.",
    path: ["failedItemIds"],
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksSchema>;
export type QcReviewInput = z.infer<typeof qcReviewSchema>;
