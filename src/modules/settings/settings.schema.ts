import { z } from "zod";
import { strongPassword } from "../../lib/password";
import { MODULE_SLUGS } from "../../lib/modules";
import { optionalText, text } from "../../middleware/validate";

export const updateProfileSchema = z
  .object({
    name: text(120).optional(),
    phone: z
      .string()
      .trim()
      .max(32)
      .regex(/^[+0-9 ()-]*$/, "Digits, spaces and + ( ) - only.")
      .optional(),
    tone: z.enum(["blue", "sky", "orange", "red", "slate"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(200),
    newPassword: strongPassword,
    confirmPassword: z.string().min(1),
  })
  .strict()
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "The two passwords don't match.",
    path: ["confirmPassword"],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: "The new password must be different from the current one.",
    path: ["newPassword"],
  });

/**
 * Module grants. The allowlist is the registry itself — an unknown slug is
 * rejected rather than stored, so `moduleAccess` can never accumulate values
 * that mean nothing to the guard.
 */
export const setModuleAccessSchema = z
  .object({
    modules: z.array(z.enum(MODULE_SLUGS)).max(MODULE_SLUGS.length),
  })
  .strict();

export const workspaceSchema = z
  .object({
    autoEmployeeId: z.boolean().optional(),
    defaultBranch: optionalText(120).nullable(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SetModuleAccessInput = z.infer<typeof setModuleAccessSchema>;
export type WorkspaceInput = z.infer<typeof workspaceSchema>;
