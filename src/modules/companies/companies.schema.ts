import { z } from "zod";
import { email, optionalText, text } from "../../middleware/validate";
import { COUNTRY_CODES } from "../../lib/countries";

/*
 * The eight fields the master's Create Company form collects, exactly as the
 * brief lists them — linkedinProfile is the only optional one.
 */

const website = z
  .string()
  .trim()
  .min(1, "A website is required.")
  .max(2048)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "Must be an http(s) URL.");

const linkedin = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined))
  .refine(
    (v) => v === undefined || /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/.+/i.test(v),
    "Must be a linkedin.com URL.",
  );

export const createCompanySchema = z
  .object({
    companyName: text(160),
    companyAddress: text(400),
    linkedinProfile: linkedin,
    companyWebsite: website,
    about: text(2000),
    ownerName: text(120),
    email,
    headBranch: text(120),
    /*
     * The head office's location. `currency` is deliberately NOT accepted —
     * the schema is `.strict()`, so sending one is a 422 rather than something
     * that quietly overrides the lookup. It is derived from headBranchCountry.
     */
    headBranchCity: text(120),
    headBranchCountry: z.enum(COUNTRY_CODES, {
      errorMap: () => ({ message: "Choose a country from the list." }),
    }),
  })
  .strict();

/** Everything optional; the owner's email is deliberately NOT changeable here. */
export const updateCompanySchema = createCompanySchema
  .partial()
  .omit({ email: true })
  .extend({ state: z.enum(["invited", "active", "disabled"]).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const listCompaniesSchema = z
  .object({
    q: optionalText(120),
    state: z.enum(["invited", "active", "disabled"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ListCompaniesQuery = z.infer<typeof listCompaniesSchema>;
