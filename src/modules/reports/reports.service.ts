import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import { notify } from "../notifications/notifications.service";
import type {
  RateReportInput,
  ReportDayQuery,
  ReportHistoryQuery,
  UpsertReportInput,
} from "./reports.schema";

/*
 * Daily reports.
 *
 * Two audiences, one table. An employee writes up a day and later sees the
 * stars that accumulated against those days; a super admin reads a day across
 * everyone and rates it. Both views come off `DailyReport` with no join, which
 * is why the rating sits on the report row — see the model comment.
 *
 * The invariant that makes the history honest is one report per person per
 * day, held by `@@unique([userId, date])` and relied on by the upsert below.
 */

const REPORT_SELECT = {
  id: true,
  userId: true,
  date: true,
  body: true,
  headline: true,
  stars: true,
  ratedById: true,
  ratedAt: true,
  feedback: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DailyReportSelect;

type ReportRow = Prisma.DailyReportGetPayload<{ select: typeof REPORT_SELECT }>;

/**
 * How far back someone may still write up a day.
 *
 * A report is a record of a day, so it has to be writable after the day ends —
 * nobody files at 23:59. It must not be writable forever, or the "day by day"
 * history becomes a thing that can be invented in one sitting at review time.
 * A week covers a holiday and a forgotten Friday and not much else.
 */
const EDIT_WINDOW_DAYS = 7;

function daysBetween(from: string, to: string): number {
  const ms = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

function shape(report: ReportRow) {
  return {
    ...report,
    ratedAt: report.ratedAt ? report.ratedAt.toISOString() : null,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    rated: report.stars !== null,
  };
}

/** Totals an employee is shown, and the super admin sees per person. */
function summarise(reports: readonly ReportRow[]) {
  const rated = reports.filter((r) => r.stars !== null);
  const stars = rated.reduce((total, r) => total + (r.stars ?? 0), 0);
  const byStars: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of rated) byStars[String(r.stars)] = (byStars[String(r.stars)] ?? 0) + 1;

  return {
    submitted: reports.length,
    ratedDays: rated.length,
    awaitingRating: reports.length - rated.length,
    /** The number the employee is actually asking for: stars earned so far. */
    stars,
    /** Out of five, across rated days only. Null before the first rating. */
    average: rated.length ? Math.round((stars / rated.length) * 10) / 10 : null,
    byStars,
  };
}

/* ------------------------------------------------------------ employee -- */

/**
 * File or revise a day.
 *
 * Upsert on (userId, date) rather than create-or-update by hand: two taps on
 * Save would otherwise write two rows for the same day, the same race the
 * clock module had. Here the unique index settles it in the database.
 *
 * A rated day is closed. Letting the text change after a super admin had
 * already given it stars would leave the star attached to words nobody read —
 * and would make it worth filing a stub, collecting the rating, and rewriting.
 */
export async function upsertMyReport(auth: UserAuth, input: UpsertReportInput) {
  /*
   * The client names its own "today" (time zones), but only within a day of
   * the server's. Without the clamp the edit window would be advisory: a
   * device claiming next year as today could write up any day it liked.
   */
  const serverDay = new Date().toISOString().slice(0, 10);
  if (Math.abs(daysBetween(input.today, serverDay)) > 1) {
    throw ApiError.badRequest("Your device's date looks wrong; check it and try again.");
  }

  const age = daysBetween(input.date, input.today);
  if (age < 0) throw ApiError.badRequest("You cannot report on a day that has not happened yet.");
  if (age > EDIT_WINDOW_DAYS) {
    throw ApiError.badRequest(
      `That day is closed. Reports can be written or changed for ${EDIT_WINDOW_DAYS} days.`,
    );
  }

  const existing = await prisma.dailyReport.findUnique({
    where: { userId_date: { userId: auth.userId, date: input.date } },
    select: { id: true, stars: true },
  });
  if (existing && existing.stars !== null) {
    throw ApiError.badRequest("That day has already been rated, so it can no longer be changed.");
  }

  const report = await prisma.dailyReport.upsert({
    where: { userId_date: { userId: auth.userId, date: input.date } },
    create: {
      companyId: auth.companyId,
      userId: auth.userId,
      date: input.date,
      body: input.body,
      headline: input.headline ?? null,
    },
    update: { body: input.body, headline: input.headline ?? null },
    select: REPORT_SELECT,
  });

  logger.info({ userId: auth.userId, date: input.date, reportId: report.id }, "daily report filed");
  return shape(report);
}

/**
 * A run of days, with the totals.
 *
 * Yours by default. `userId` reads someone else's, which only a super admin
 * may do — the same shape and the same code as your own view, so the
 * Playground person panel and the employee's own page cannot drift apart.
 */
export async function getReportHistory(auth: UserAuth, queryInput: ReportHistoryQuery) {
  const targetId = queryInput.userId ?? auth.userId;
  if (targetId !== auth.userId && !isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can read someone else's reports.");
  }

  const user = await prisma.user.findFirst({
    where: { id: targetId, companyId: auth.companyId },
    select: { id: true, name: true, empId: true, avatar: true, tone: true },
  });
  if (!user) throw ApiError.notFound("That employee is not in this company.");

  const reports = await prisma.dailyReport.findMany({
    where: { companyId: auth.companyId, userId: targetId, date: { gte: queryInput.from, lte: queryInput.to } },
    select: REPORT_SELECT,
    orderBy: { date: "desc" },
  });

  // Lifetime stars, not just the window — this is the number an employee is
  // asking for when they ask how many they have, and a date filter would make
  // it shrink when they changed the month they were looking at.
  const lifetime = await prisma.dailyReport.aggregate({
    where: { companyId: auth.companyId, userId: targetId, stars: { not: null } },
    _sum: { stars: true },
    _count: { _all: true },
  });

  const totalStars = lifetime._sum.stars ?? 0;
  const totalRated = lifetime._count._all;

  return {
    user,
    from: queryInput.from,
    to: queryInput.to,
    reports: reports.map(shape),
    summary: summarise(reports),
    lifetime: {
      stars: totalStars,
      ratedDays: totalRated,
      average: totalRated ? Math.round((totalStars / totalRated) * 10) / 10 : null,
    },
  };
}

/* --------------------------------------------------------- super admin -- */

/**
 * One day, everyone.
 *
 * People with no report are included as a null row. "Who has not written one
 * up" is the question a super admin opens this on, and a list that silently
 * omitted them would answer the opposite question — see the roster in the
 * clock module, which includes absentees for the same reason.
 */
export async function getReportDay(auth: UserAuth, queryInput: ReportDayQuery) {
  if (!isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can see everyone's reports.");
  }

  const [users, reports] = await Promise.all([
    prisma.user.findMany({
      where: { companyId: auth.companyId, state: { not: "disabled" } },
      select: {
        id: true,
        name: true,
        empId: true,
        email: true,
        roles: true,
        avatar: true,
        tone: true,
        currentStatus: true,
        branch: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.dailyReport.findMany({
      where: { companyId: auth.companyId, date: queryInput.date },
      select: REPORT_SELECT,
    }),
  ]);

  const byUser = new Map(reports.map((r) => [r.userId, r]));
  const q = queryInput.q?.trim().toLowerCase() ?? "";

  const rows = users
    .filter((user) => {
      if (!q) return true;
      return (
        user.name.toLowerCase().includes(q) ||
        user.empId.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q)
      );
    })
    .map((user) => {
      const report = byUser.get(user.id) ?? null;
      return {
        user: { ...user, branch: user.branch?.name ?? null },
        report: report ? shape(report) : null,
      };
    });

  const counts = {
    total: rows.length,
    filed: rows.filter((r) => r.report !== null).length,
    missing: rows.filter((r) => r.report === null).length,
    unrated: rows.filter((r) => r.report !== null && r.report.stars === null).length,
  };

  const filtered =
    queryInput.filter === "filed"
      ? rows.filter((r) => r.report !== null)
      : queryInput.filter === "missing"
        ? rows.filter((r) => r.report === null)
        : queryInput.filter === "unrated"
          ? rows.filter((r) => r.report !== null && r.report.stars === null)
          : rows;

  return { date: queryInput.date, rows: filtered, counts };
}

/**
 * Give a day its stars.
 *
 * Re-rating is allowed and overwrites: a super admin who clicked three and
 * meant four should not have to live with it. `ratedById` records who, so a
 * disputed star has a name against it.
 */
export async function rateReport(auth: UserAuth, reportId: string, input: RateReportInput) {
  if (!isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can rate reports.");
  }

  const existing = await prisma.dailyReport.findFirst({
    where: { id: reportId, companyId: auth.companyId },
    select: { id: true, userId: true, date: true },
  });
  if (!existing) throw ApiError.notFound("That report no longer exists.");

  const report = await prisma.dailyReport.update({
    where: { id: existing.id },
    data: {
      stars: input.stars,
      feedback: input.feedback ?? null,
      ratedById: auth.userId,
      ratedAt: new Date(),
    },
    select: REPORT_SELECT,
  });

  await notify(auth.companyId, [existing.userId], {
    kind: "reportRated",
    title: `Your report for ${existing.date} was rated ${input.stars}/5`,
    detail: input.feedback ?? "Open Reports to see the rating.",
  });

  logger.info({ reportId: report.id, stars: input.stars, by: auth.userId }, "report rated");
  return shape(report);
}
