import { z } from "zod";
import { email, objectId, optionalText, text } from "../../middleware/validate";

export const ROLE_VALUES = [
  "developer",
  "sales",
  "qualityCheck",
  "manager",
  "teamLeader",
  "superAdmin",
  "client",
  "vendor",
] as const;

export const roleEnum = z.enum(ROLE_VALUES);
export const empTypeEnum = z.enum(["employee", "manager", "admin"]);
export const empStatusEnum = z.enum(["fullTime", "partTime", "contractBased"]);
export const currentStatusEnum = z.enum(["idle", "workAssigned", "break", "leave"]);
export const entityStateEnum = z.enum(["invited", "active", "disabled"]);

/** Matches the frontend's JDX-041 series, but any short code is allowed. */
const empIdField = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Letters, numbers, dot, dash and underscore only.");

/** Avatar colour. Closed set — it is rendered straight into a style attribute. */
const toneField = z.enum(["blue", "sky", "orange", "red", "slate"]);

const phoneField = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+0-9 ()-]*$/, "Digits, spaces and + ( ) - only.")
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined));

export const createEmployeeSchema = z
  .object({
    name: text(120),
    email,
    /** Omit to auto-generate the next JDX-NNN. */
    empId: empIdField.optional(),
    roles: z.array(roleEnum).min(1, "Pick at least one role.").max(6),
    empType: empTypeEnum.default("employee"),
    empStatus: empStatusEnum.default("fullTime"),
    currentStatus: currentStatusEnum.default("idle"),
    /** Branch by name — matched or created inside the caller's company. */
    branch: optionalText(120),
    branchId: objectId.optional(),
    kra: z.number().int().min(0).max(100).default(100),
    openWork: z.number().int().min(0).max(9999).default(0),
    reportsToId: objectId.optional().nullable(),
    phone: phoneField,
    tone: toneField.default("blue"),
    /** Off to create the account without emailing an invite. */
    sendInvite: z.boolean().default(true),
  })
  .strict();

export const updateEmployeeSchema = createEmployeeSchema
  .partial()
  .omit({ sendInvite: true })
  .extend({ state: entityStateEnum.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listEmployeesSchema = z
  .object({
    q: optionalText(120),
    role: roleEnum.optional(),
    state: entityStateEnum.optional(),
    currentStatus: currentStatusEnum.optional(),
    branch: optionalText(120),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const setStatusSchema = z.object({ currentStatus: currentStatusEnum }).strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesSchema>;
