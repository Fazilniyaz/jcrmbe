import { Router } from "express";
import { z } from "zod";
import { ok } from "../../lib/http";
import { body, objectId, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  rateReportSchema,
  reportDaySchema,
  reportHistorySchema,
  upsertReportSchema,
  type RateReportInput,
  type ReportDayQuery,
  type ReportHistoryQuery,
  type UpsertReportInput,
} from "./reports.schema";
import { getReportDay, getReportHistory, rateReport, upsertMyReport } from "./reports.service";

/*
 * Daily reports.
 *
 * The module is `reports`, which every logged-in person has: writing up your
 * own day is not a privilege to be granted, and withholding it would leave the
 * super admin with a grid of blanks they could not explain. Who may read ACROSS
 * people, and who may hand out stars, is decided in the service by role rather
 * than by module level — a `reports:edit` grant means "may file reports", not
 * "may rate the company".
 */
export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireUser, requireModule("reports"));

const idParam = z.object({ id: objectId });

/** Your own run of days, or — with ?userId, super admin only — someone else's. */
reportsRouter.get("/", validate({ query: reportHistorySchema }), async (req, res) => {
  ok(res, await getReportHistory(actor(req), query<ReportHistoryQuery>(req)));
});

/*
 * Before /:id, deliberately — Express matches in order, so "day" registered
 * after the parameterised route would arrive as an :id that fails ObjectId
 * validation. Same trap as /sprints/assign.
 */
reportsRouter.get("/day", validate({ query: reportDaySchema }), async (req, res) => {
  ok(res, await getReportDay(actor(req), query<ReportDayQuery>(req)));
});

/** File or revise one day. Upsert, so Save twice is Save once. */
reportsRouter.put("/me", validate({ body: upsertReportSchema }), async (req, res) => {
  ok(res, await upsertMyReport(actor(req), body<UpsertReportInput>(req)));
});

reportsRouter.post(
  "/:id/rate",
  validate({ params: idParam, body: rateReportSchema }),
  async (req, res) => {
    ok(res, await rateReport(actor(req), params<{ id: string }>(req).id, body<RateReportInput>(req)));
  },
);
