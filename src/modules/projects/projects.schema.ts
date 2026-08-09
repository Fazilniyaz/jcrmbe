import { z } from "zod";
import { objectId, optionalIsoDate, optionalText, text } from "../../middleware/validate";

export const projectStateEnum = z.enum([
  "planning",
  "active",
  "atRisk",
  "delayed",
  "onHold",
  "completed",
  "cancelled",
]);

export const milestoneStatusEnum = z.enum(["planned", "inProgress", "done", "delayed"]);
export const secretEnvEnum = z.enum(["local", "development", "staging", "production"]);

const idList = (max: number) => z.array(objectId).max(max).default([]);

export const createProjectSchema = z
  .object({
    name: text(160),
    description: optionalText(4000),
    code: optionalText(32),
    client: optionalText(160),
    clientId: optionalText(64),
    problemStatement: optionalText(4000),
    solution: optionalText(4000),
    state: projectStateEnum.default("planning"),
    startDate: optionalIsoDate,
    dueDate: optionalIsoDate,
    /** Managers / team leaders invited to lead this project. */
    managerIds: idList(10),
    /**
     * Members invited up front. Only a superAdmin may do this at create time —
     * for a manager the flow is: accept the project first, then add people.
     */
    memberIds: idList(50),
  })
  .strict();

export const updateProjectSchema = createProjectSchema
  .partial()
  .omit({ managerIds: true, memberIds: true })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listProjectsSchema = z
  .object({
    q: optionalText(120),
    state: projectStateEnum.optional(),
    /** "mine" limits to projects the caller is a member of, even for a superAdmin. */
    scope: z.enum(["all", "mine"]).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const inviteMembersSchema = z
  .object({ userIds: z.array(objectId).min(1).max(50) })
  .strict();

export const respondSchema = z
  .object({ response: z.enum(["accept", "decline"]) })
  .strict();

export const planSchema = z
  .object({
    plan: z
      .array(
        z
          .object({
            id: optionalText(64),
            label: text(200),
            due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a yyyy-mm-dd date."),
            status: milestoneStatusEnum.default("planned"),
            note: optionalText(1000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const secretsSchema = z
  .object({
    secrets: z
      .array(
        z
          .object({
            id: optionalText(64),
            key: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an env-style name, e.g. API_KEY."),
            value: z.string().max(8000),
            env: secretEnvEnum,
            note: optionalText(500),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsSchema>;
export type PlanInput = z.infer<typeof planSchema>;
export type SecretsInput = z.infer<typeof secretsSchema>;
