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
    /*
     * The avatar, as a data URL the client has already squared and compressed.
     *
     * The regex is the guard that matters: only an image data URL is accepted,
     * so this field cannot be used to smuggle a script or an arbitrary link
     * into something that is rendered as `src` on every screen. Null clears it.
     * ~192 KB of base64 is about a 128px JPEG with room to spare.
     */
    avatar: z
      .string()
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Not an image.")
      .max(196_608, "That picture is too large — try a smaller one.")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

/**
 * The status line. Everything is optional and nullable: clearing a status is
 * sending nulls, not a separate endpoint.
 */
export const setStatusSchema = z
  .object({
    text: z.string().trim().max(100).nullable().optional(),
    emoji: z.string().trim().max(16).nullable().optional(),
    /** When it lapses. Null means "until I clear it". */
    until: z.string().datetime().nullable().optional(),
  })
  .strict();

/** The heartbeat, and the manual away switch. */
export const presenceSchema = z
  .object({ presence: z.enum(["auto", "away"]).optional() })
  .strict();

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
const MODULE_GRANT = new RegExp(`^(${MODULE_SLUGS.join("|")})(:(view|edit))?$`);

export const setModuleAccessSchema = z
  .object({
    /*
     * Each entry is `"<slug>"` or `"<slug>:<view|edit>"`. The bare form predates
     * access levels and still means `edit`, so an older client keeps working.
     */
    modules: z
      .array(z.string().regex(MODULE_GRANT, "Unknown module or access level."))
      .max(MODULE_SLUGS.length),
  })
  .strict();

export const workspaceSchema = z
  .object({
    autoEmployeeId: z.boolean().optional(),
    defaultBranch: optionalText(120).nullable(),
    /** Org-wide default for whether joining a project needs acceptance. */
    requireProjectAcceptance: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SetModuleAccessInput = z.infer<typeof setModuleAccessSchema>;
export type WorkspaceInput = z.infer<typeof workspaceSchema>;
export type SetStatusInput = z.infer<typeof setStatusSchema>;
export type PresenceInput = z.infer<typeof presenceSchema>;
