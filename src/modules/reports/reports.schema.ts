import { z } from "zod";
import { objectId, optionalText } from "../../middleware/validate";
import { sanitizeRichText } from "../../lib/richText";

/*
 * Daily reports.
 *
 * `date` is the author's local calendar day, exactly as in the clock module
 * and for the same reason: the server cannot tell from a UTC instant which day
 * someone believes they are writing up. It is never read from the request for
 * anything but the calendar; nothing here trusts a client timestamp.
 */

const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD local date.");

/**
 * The report body: rich text in, sanitised HTML out, and required.
 *
 * `optionalRichText` is the shared helper, and a report with no body is not a
 * report — so this is its required sibling, with the same raw cap and the same
 * "formatting but no words" collapse, which here fails rather than vanishing.
 */
const reportBody = z
  .string()
  .max(20_000, "Must be 20000 characters or fewer, including formatting.")
  .transform((raw) => sanitizeRichText(raw))
  .refine((clean) => clean.length > 0, "Write what you worked on.");

export const upsertReportSchema = z
  .object({
    date: localDate,
    /**
     * The author's local day, so "the last seven days" means theirs.
     *
     * Sent rather than inferred for the same reason as `date`, and sanity
     * checked against the server's own clock in the service — a device may be
     * a time zone away, not a year.
     */
    today: localDate,
    body: reportBody,
    /** One line for the super admin's grid, so they need not open every day. */
    headline: optionalText(140),
  })
  .strict();

/** An employee's own run of days, or — with userId — someone else's. */
export const reportHistorySchema = z
  .object({
    from: localDate,
    to: localDate,
    userId: objectId.optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: "`from` must not be after `to`.", path: ["from"] });

/** The super admin's grid: one day, everyone. */
export const reportDaySchema = z
  .object({
    date: localDate,
    q: optionalText(120),
    /** Narrows to the people who have not filed yet, for chasing them. */
    filter: z.enum(["all", "filed", "missing", "unrated"]).default("all"),
  })
  .strict();

export const rateReportSchema = z
  .object({
    stars: z.coerce.number().int().min(1).max(5),
    feedback: optionalText(600),
  })
  .strict();

export type UpsertReportInput = z.infer<typeof upsertReportSchema>;
export type ReportHistoryQuery = z.infer<typeof reportHistorySchema>;
export type ReportDayQuery = z.infer<typeof reportDaySchema>;
export type RateReportInput = z.infer<typeof rateReportSchema>;
