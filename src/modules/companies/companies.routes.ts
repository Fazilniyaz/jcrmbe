import { Router } from "express";
import { z } from "zod";
import { created, noContent, ok, pageMeta } from "../../lib/http";
import { ApiError } from "../../lib/errors";
import { body, idParam, params, query, validate } from "../../middleware/validate";
import { requireAuth, requireMaster, requireModule } from "../../middleware/auth";
import { mailLimiter } from "../../middleware/rateLimit";
import {
  createCompanySchema,
  listCompaniesSchema,
  updateCompanySchema,
  type CreateCompanyInput,
  type ListCompaniesQuery,
  type UpdateCompanyInput,
} from "./companies.schema";
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  masterDashboard,
  resendOwnerInvite,
  updateCompany,
} from "./companies.service";

/*
 * Master-only. requireMaster is applied to the whole router rather than each
 * route, so a route added later cannot accidentally be reachable by a company
 * user — the default is closed.
 */
export const companiesRouter = Router();

companiesRouter.use(requireAuth, requireMaster, requireModule("companies"));

companiesRouter.get("/", validate({ query: listCompaniesSchema }), async (req, res) => {
  const q = query<ListCompaniesQuery>(req);
  const { rows, total } = await listCompanies(q);
  ok(res, rows, pageMeta(total, q.page, q.perPage));
});

companiesRouter.post("/", mailLimiter, validate({ body: createCompanySchema }), async (req, res) => {
  const result = await createCompany(body<CreateCompanyInput>(req));
  created(res, result, `/api/v1/companies/${result.company.id}`);
});

companiesRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await getCompany(params<{ id: string }>(req).id));
});

companiesRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateCompanySchema }),
  async (req, res) => {
    ok(res, await updateCompany(params<{ id: string }>(req).id, body<UpdateCompanyInput>(req)));
  },
);

companiesRouter.post(
  "/:id/invite/resend",
  mailLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    ok(res, await resendOwnerInvite(params<{ id: string }>(req).id));
  },
);

/**
 * Destructive and irreversible, so the caller has to type the company name
 * back. That is a confirmation step, not an authorisation one — the guard above
 * is what authorises.
 */
companiesRouter.delete(
  "/:id",
  validate({
    params: idParam,
    body: z.object({ confirmName: z.string().trim().min(1) }).strict(),
  }),
  async (req, res) => {
    const { id } = params<{ id: string }>(req);
    const { confirmName } = body<{ confirmName: string }>(req);

    const company = await getCompany(id);
    if (company.companyName !== confirmName) {
      throw ApiError.badRequest("The company name doesn't match. Nothing was deleted.");
    }

    await deleteCompany(id);
    noContent(res);
  },
);

/* -------------------------------------------------- master dashboard -- */

export const masterRouter = Router();
masterRouter.use(requireAuth, requireMaster);

masterRouter.get("/dashboard", requireModule("dashboard"), async (_req, res) => {
  ok(res, await masterDashboard());
});
