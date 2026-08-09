import { z } from "zod";
import { objectId, text } from "../../middleware/validate";
import { COUNTRY_CODES } from "../../lib/countries";

/**
 * The sentinel that means "don't scope to anything — show the whole group".
 *
 * `defaultBranch` is a nullable string on Company.settings, and null already
 * means something specific: "nobody has chosen, so use the head branch". A
 * company always has a head branch, so there is no third null-ish state left to
 * express "all of them" — hence one reserved value. `*` is not a legal branch
 * name (see `branchName`), so it can never collide with a real one.
 */
export const ALL_BRANCHES = "*";

/** Anything but the sentinel, and no leading/trailing whitespace surprises. */
const branchName = text(120).refine(
  (v) => v !== ALL_BRANCHES,
  "That name is reserved.",
);

/**
 * Where the office is.
 *
 * `currency` is absent on purpose and the schemas are `.strict()`, so sending
 * one is a 422 rather than an override — it is looked up from `country`.
 */
const country = z.enum(COUNTRY_CODES, {
  errorMap: () => ({ message: "Choose a country from the list." }),
});

export const createBranchSchema = z
  .object({
    name: branchName,
    city: text(120),
    country,
    /** Make it the default as soon as it exists. */
    setDefault: z.boolean().default(false),
  })
  .strict();

export const updateBranchSchema = z
  .object({
    name: branchName.optional(),
    city: text(120).optional(),
    country: country.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

/**
 * `branchId: null` resets to the head branch — the standing default.
 * `all: true` lifts the scope entirely.
 */
export const setDefaultBranchSchema = z
  .object({
    branchId: objectId.nullable().optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => !(v.all && v.branchId),
    "Choose a branch or all branches, not both.",
  );

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type SetDefaultBranchInput = z.infer<typeof setDefaultBranchSchema>;
