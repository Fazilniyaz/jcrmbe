import { z } from "zod";
import { objectId, optionalText } from "../../middleware/validate";

/*
 * Attendance.
 *
 * The client never sends a timestamp. `inAt` and `outAt` are stamped by the
 * server from its own clock, because a device clock is both wrong often and
 * trivially editable — letting a browser name its own clock-in time would make
 * the timesheet a suggestion.
 *
 * `date` IS sent: it is the person's local calendar day, which the server
 * cannot know from a UTC instant. A shift started at 23:40 belongs to the day
 * the person was working, not to tomorrow in UTC.
 */

const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD local date.");

export const clockInSchema = z.object({ date: localDate, note: optionalText(200) }).strict();

export const clockOutSchema = z.object({ note: optionalText(200) }).strict();

/** One endpoint for both ends of a break; the open/closed state decides which. */
export const breakSchema = z.object({}).strict();

export const myShiftsSchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(14) })
  .strict();

export const rosterSchema = z
  .object({
    /** The viewer's local day, so "today" means their today. */
    date: localDate,
    q: optionalText(120),
    /** Which tab is open. Both lists are always returned; this only sorts. */
    tab: z.enum(["in", "out"]).default("in"),
  })
  .strict();

/** An admin correcting someone's day — not self-service, see the service. */
export const adjustShiftSchema = z
  .object({ userId: objectId, note: optionalText(200) })
  .strict();

export type ClockInInput = z.infer<typeof clockInSchema>;
export type ClockOutInput = z.infer<typeof clockOutSchema>;
export type MyShiftsQuery = z.infer<typeof myShiftsSchema>;
export type RosterQuery = z.infer<typeof rosterSchema>;
