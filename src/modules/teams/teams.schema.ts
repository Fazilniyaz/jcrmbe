import { z } from "zod";
import { objectId, optionalText, text } from "../../middleware/validate";

/*
 * A team is a named set of people. Nothing here carries per-member state —
 * see the note on the Team model for why membership is a plain id list.
 */

const memberIds = z.array(objectId).max(200).default([]);

export const createTeamSchema = z
  .object({
    name: text(80),
    description: optionalText(500),
    tone: optionalText(20),
    /** Must be one of `memberIds`; the service enforces it. */
    leadId: objectId.nullish(),
    memberIds,
  })
  .strict();

export const updateTeamSchema = createTeamSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
