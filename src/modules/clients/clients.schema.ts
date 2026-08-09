import { z } from "zod";
import { email, optionalText, text } from "../../middleware/validate";

export const clientStatusEnum = z.enum(["active", "onboarding", "dormant"]);

const phone = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+0-9 ()-]*$/, "Digits, spaces and + ( ) - only.")
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined));

export const createClientSchema = z
  .object({
    name: text(160),
    contact: text(120),
    email,
    phone,
    industry: optionalText(120),
    /** Lifetime value. Integer minor-unit-free — the UI formats it. */
    value: z.number().int().min(0).max(1_000_000_000).default(0),
    since: optionalText(16),
    status: clientStatusEnum.default("onboarding"),
    notes: optionalText(2000),
    tone: z.enum(["blue", "sky", "orange", "red", "slate"]).default("blue"),
    /** Omit to auto-generate the next CL-NN. */
    code: optionalText(32),
  })
  .strict();

export const updateClientSchema = createClientSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listClientsSchema = z
  .object({
    q: optionalText(120),
    status: clientStatusEnum.optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsSchema>;
