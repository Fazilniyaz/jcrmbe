import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { liveStatus, presenceOf } from "../../lib/presence";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import type {
  ClockInInput,
  ClockOutInput,
  ClockStatsQuery,
  MyShiftsQuery,
  RosterQuery,
} from "./clock.schema";

/*
 * Attendance.
 *
 * "Clocked in" has exactly one definition in this codebase: a Shift row whose
 * `outAt` is null. Nothing caches it, nothing mirrors it onto the User, and no
 * endpoint accepts it as input. Everything below — the button state, the two
 * roster tabs, the counts — is read from that one fact, which is why they
 * cannot disagree with each other.
 *
 * Break time is accumulated rather than listed: `breakAt` is the start of the
 * break in progress, and ending one folds the elapsed minutes into
 * `breakMinutes` and clears it. Storing a list of break windows would be more
 * faithful, and nothing in the product asks a question that needs it.
 */

const SHIFT_SELECT = {
  id: true,
  userId: true,
  date: true,
  inAt: true,
  outAt: true,
  breakMinutes: true,
  breakAt: true,
  note: true,
} satisfies Prisma.ShiftSelect;

type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof SHIFT_SELECT }>;

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/**
 * Worked minutes, breaks excluded.
 *
 * An OPEN shift counts up to now, and an open BREAK inside it is subtracted as
 * it runs — otherwise someone who walked away at lunch would keep earning
 * minutes until they remembered to come back and end it.
 */
function workedMinutes(shift: ShiftRow, now = new Date()): number {
  const end = shift.outAt ?? now;
  const gross = minutesBetween(shift.inAt, end);
  const running = shift.breakAt ? minutesBetween(shift.breakAt, end) : 0;
  return Math.max(0, gross - shift.breakMinutes - running);
}

function shapeShift(shift: ShiftRow, now = new Date()) {
  return {
    ...shift,
    inAt: shift.inAt.toISOString(),
    outAt: shift.outAt ? shift.outAt.toISOString() : null,
    breakAt: shift.breakAt ? shift.breakAt.toISOString() : null,
    open: shift.outAt === null,
    onBreak: shift.breakAt !== null,
    workedMinutes: workedMinutes(shift, now),
  };
}

/** Every shift this person has open. Normally none or one — see `claimOpenShift`. */
async function openShiftsFor(companyId: string, userId: string): Promise<ShiftRow[]> {
  return prisma.shift.findMany({
    where: { companyId, userId, outAt: null },
    select: SHIFT_SELECT,
    orderBy: { inAt: "asc" },
  });
}

/**
 * The caller's shift in progress, if any — and only ever one.
 *
 * MongoDB cannot express "at most one row per user where outAt is null" as a
 * constraint Prisma can declare (a partial unique index is not in the schema
 * language), so the invariant is kept here instead: if more than one open row
 * is ever found, the EARLIEST wins and the rest are discarded on sight. Two
 * open shifts made `workedMinutes` double-count and made "clocked in"
 * ambiguous for the roster, which reads the open row.
 *
 * Discarding means deleting, not closing. A duplicate is an artifact of a
 * double submit, so it is noise, not a shift someone worked; closing it would
 * leave a one-second shift in the timesheet forever.
 */
async function openShiftFor(companyId: string, userId: string): Promise<ShiftRow | null> {
  const open = await openShiftsFor(companyId, userId);
  if (open.length <= 1) return open[0] ?? null;

  const keep = open[0]!;
  const extra = open.slice(1);
  logger.warn(
    { userId, keep: keep.id, discarded: extra.map((s) => s.id) },
    "more than one open shift; keeping the earliest",
  );
  await prisma.shift.deleteMany({ where: { id: { in: extra.map((s) => s.id) } } });
  return keep;
}

/* ------------------------------------------------------------ own clock -- */

export async function getMyClock(auth: UserAuth, queryInput: MyShiftsQuery) {
  const now = new Date();

  const [open, recent] = await Promise.all([
    openShiftFor(auth.companyId, auth.userId),
    prisma.shift.findMany({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: SHIFT_SELECT,
      orderBy: { inAt: "desc" },
      take: queryInput.days,
    }),
  ]);

  return {
    open: open ? shapeShift(open, now) : null,
    shifts: recent.map((s) => shapeShift(s, now)),
  };
}

/**
 * Clock in.
 *
 * Refuses when a shift is already open rather than silently opening a second
 * one. Two open shifts would make `workedMinutes` double-count and would make
 * "clocked in" ambiguous for the roster, which reads the open row.
 */
export async function clockIn(auth: UserAuth, input: ClockInInput) {
  const existing = await openShiftFor(auth.companyId, auth.userId);
  if (existing) throw ApiError.badRequest("You are already clocked in.");

  const created = await prisma.shift.create({
    data: {
      companyId: auth.companyId,
      userId: auth.userId,
      date: input.date,
      inAt: new Date(),
      note: input.note ?? null,
    },
    select: SHIFT_SELECT,
  });

  /*
   * Insert, then check — the check above can be lost to a race.
   *
   * Two taps on the button, or one tap and a retry, send two requests; both
   * read "no open shift" before either has written, and the company ends up
   * with two shifts open at once. That is not hypothetical: it is in the data.
   *
   * There is no unique index to lean on (see `openShiftFor`), so the racers
   * settle it after the fact, deterministically: re-read, and whoever did not
   * insert the earliest row removes their own and reports the winner. Both
   * callers get the same shift back, so a double tap reads as one clock-in
   * rather than as an error, and nothing is left behind either way.
   */
  const winner = await openShiftFor(auth.companyId, auth.userId);
  if (winner && winner.id !== created.id) {
    await prisma.shift.deleteMany({ where: { id: created.id } });
    logger.warn({ userId: auth.userId, lost: created.id, kept: winner.id }, "duplicate clock-in");
    return shapeShift(winner);
  }

  logger.info({ userId: auth.userId, shiftId: created.id }, "clocked in");
  return shapeShift(created);
}

/**
 * Clock out.
 *
 * An open break is closed first, so walking away and clocking out from the
 * phone does not leave a break running forever inside a finished shift.
 */
export async function clockOut(auth: UserAuth, input: ClockOutInput) {
  const open = await openShiftFor(auth.companyId, auth.userId);
  if (!open) throw ApiError.badRequest("You are not clocked in.");

  const now = new Date();
  const closedBreak = open.breakAt ? minutesBetween(open.breakAt, now) : 0;

  const shift = await prisma.shift.update({
    where: { id: open.id },
    data: {
      outAt: now,
      breakAt: null,
      breakMinutes: open.breakMinutes + closedBreak,
      ...(input.note ? { note: input.note } : {}),
    },
    select: SHIFT_SELECT,
  });

  logger.info({ userId: auth.userId, shiftId: shift.id }, "clocked out");
  return shapeShift(shift, now);
}

/** Start a break, or end the one in progress. One endpoint, state decides. */
export async function toggleBreak(auth: UserAuth) {
  const open = await openShiftFor(auth.companyId, auth.userId);
  if (!open) throw ApiError.badRequest("You are not clocked in.");

  const now = new Date();
  const shift = await prisma.shift.update({
    where: { id: open.id },
    data: open.breakAt
      ? { breakAt: null, breakMinutes: open.breakMinutes + minutesBetween(open.breakAt, now) }
      : { breakAt: now },
    select: SHIFT_SELECT,
  });

  return shapeShift(shift, now);
}

/* --------------------------------------------------------------- roster -- */

export type RosterPerson = {
  id: string;
  name: string;
  empId: string;
  email: string;
  roles: string[];
  branch: string | null;
  tone: string;
  avatar: string | null;
  currentStatus: string;
  presence: ReturnType<typeof presenceOf>;
  status: ReturnType<typeof liveStatus>;
  shift: ReturnType<typeof shapeShift> | null;
  /** True when the open shift exists — the only definition, see the header. */
  clockedIn: boolean;
  onBreak: boolean;
  workedMinutes: number;
};

/**
 * Who is in and who is out, for one calendar day.
 *
 * Assembled in three flat queries and joined in memory. The alternative — ask
 * per person — is one round trip per employee to draw a list that is read
 * every few seconds while a tab is open.
 *
 * "Out" deliberately means BOTH "clocked out again" and "never started": from
 * the admin's side those are the same question ("who is not working right
 * now"), and splitting them into three tabs was not what was asked for. The
 * row says which it is.
 */
export async function getRoster(auth: UserAuth, queryInput: RosterQuery) {
  if (!isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can see the whole roster.");
  }

  const now = new Date();

  const [users, shifts] = await Promise.all([
    prisma.user.findMany({
      where: { companyId: auth.companyId, state: { not: "disabled" } },
      select: {
        id: true,
        name: true,
        empId: true,
        email: true,
        roles: true,
        tone: true,
        avatar: true,
        currentStatus: true,
        statusText: true,
        statusEmoji: true,
        statusUntil: true,
        presence: true,
        lastSeenAt: true,
        branch: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    /*
     * Both the day's shifts AND any still-open shift, which may have started
     * yesterday. A night shift that crosses midnight is still someone being at
     * work right now, and filtering on `date` alone would have moved them into
     * the "clocked out" tab at midnight while they were sitting there.
     */
    prisma.shift.findMany({
      where: {
        companyId: auth.companyId,
        OR: [{ date: queryInput.date }, { outAt: null }],
      },
      select: SHIFT_SELECT,
      orderBy: { inAt: "desc" },
    }),
  ]);

  // The newest shift per person, open ones winning — `orderBy inAt desc` means
  // the first row seen for a user is their latest, so later ones are skipped.
  const byUser = new Map<string, ShiftRow>();
  for (const shift of shifts) {
    const held = byUser.get(shift.userId);
    if (!held || (held.outAt !== null && shift.outAt === null)) byUser.set(shift.userId, shift);
  }

  const q = queryInput.q?.trim().toLowerCase() ?? "";

  const people: RosterPerson[] = users
    .filter((user) => {
      if (!q) return true;
      return (
        user.name.toLowerCase().includes(q) ||
        user.empId.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q)
      );
    })
    .map((user) => {
      const shift = byUser.get(user.id) ?? null;
      return {
        id: user.id,
        name: user.name,
        empId: user.empId,
        email: user.email,
        roles: user.roles,
        branch: user.branch?.name ?? null,
        tone: user.tone,
        avatar: user.avatar,
        currentStatus: user.currentStatus,
        presence: presenceOf(user),
        status: liveStatus(user),
        shift: shift ? shapeShift(shift, now) : null,
        clockedIn: shift !== null && shift.outAt === null,
        onBreak: shift !== null && shift.breakAt !== null,
        workedMinutes: shift ? workedMinutes(shift, now) : 0,
      };
    });

  const inNow = people.filter((p) => p.clockedIn);
  const out = people.filter((p) => !p.clockedIn);

  return {
    date: queryInput.date,
    in: inNow,
    out,
    counts: {
      total: people.length,
      in: inNow.length,
      out: out.length,
      onBreak: inNow.filter((p) => p.onBreak).length,
      // Started the day and finished it, as against never having started.
      finished: out.filter((p) => p.shift?.date === queryInput.date).length,
      notStarted: out.filter((p) => p.shift?.date !== queryInput.date).length,
    },
  };
}

/* ---------------------------------------------------------------- stats -- */

/*
 * Local-day arithmetic.
 *
 * Every date in this module is the person's own calendar day as a
 * `YYYY-MM-DD` string, never an instant, so the maths below is done on the
 * string through UTC parts. Using the server's local time zone here would move
 * someone's week boundary to wherever the server happens to be hosted, and
 * ISO dates sort lexicographically, so a range filter stays a string compare.
 */

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fromDayNumber(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days * 86_400_000);
}

/** 0 = Sunday, as `Date` has it. */
function weekday(date: string): number {
  return new Date(dayNumber(date)).getUTCDay();
}

/** The Monday of the week containing `date`. Weeks run Monday to Sunday. */
function weekStartOf(date: string): string {
  const dow = weekday(date);
  return addDays(date, -((dow + 6) % 7));
}

function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export type ClockStats = Awaited<ReturnType<typeof getClockStats>>;

/**
 * Hours worked today, this week and this month, and how consistently.
 *
 * Read for yourself, or — super admin only — for anyone in the company, which
 * is what the Playground person panel asks for.
 *
 * CONSISTENCY is the part worth explaining. It is days present over days the
 * company was open, both counted from the data: a date the company was open is
 * one where at least one person clocked in. Nothing in the schema says which
 * days this company works, and assuming Monday-to-Friday would have marked a
 * six-day week as 120% and a four-day week as chronically absent. Deriving the
 * calendar from attendance costs one extra indexed query and is right for
 * whatever week the company actually keeps, including public holidays, which
 * simply never become expected days.
 *
 * Days before someone joined are not held against them either.
 */
export async function getClockStats(auth: UserAuth, queryInput: ClockStatsQuery) {
  const targetId = queryInput.userId ?? auth.userId;
  if (targetId !== auth.userId && !isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can see someone else's hours.");
  }

  const user = await prisma.user.findFirst({
    where: { id: targetId, companyId: auth.companyId },
    select: { id: true, name: true, empId: true, joinedAt: true },
  });
  if (!user) throw ApiError.notFound("That employee is not in this company.");

  const today = queryInput.date;
  const weekStart = weekStartOf(today);
  const monthStart = monthStartOf(today);
  const from = weekStart < monthStart ? weekStart : monthStart;
  const now = new Date();

  const [shifts, companyDays] = await Promise.all([
    prisma.shift.findMany({
      where: {
        companyId: auth.companyId,
        userId: targetId,
        // An open shift counts even if it started before the window — a night
        // shift that began yesterday is time being worked right now.
        OR: [{ date: { gte: from, lte: today } }, { outAt: null }],
      },
      select: SHIFT_SELECT,
      orderBy: { inAt: "asc" },
    }),
    prisma.shift.findMany({
      where: { companyId: auth.companyId, date: { gte: monthStart, lte: today } },
      select: { date: true },
      distinct: ["date"],
      orderBy: { date: "asc" },
    }),
  ]);

  const minutesByDay = new Map<string, number>();
  for (const shift of shifts) {
    minutesByDay.set(shift.date, (minutesByDay.get(shift.date) ?? 0) + workedMinutes(shift, now));
  }

  const sum = (lo: string, hi: string) => {
    let total = 0;
    for (const [day, minutes] of minutesByDay) if (day >= lo && day <= hi) total += minutes;
    return total;
  };

  const joined = user.joinedAt.toISOString().slice(0, 10);
  const expected = companyDays.map((d) => d.date).filter((d) => d >= joined);
  const present = expected.filter((d) => (minutesByDay.get(d) ?? 0) > 0);

  /*
   * The streak ends at the last expected day that has already had a chance to
   * happen. Today is skipped while it is still empty — a count that read 0
   * every morning until the person clocked in, then jumped back to 12, would
   * be measuring the hour of the day rather than the habit.
   */
  const walk = [...expected].reverse();
  if (walk[0] === today && !minutesByDay.get(today)) walk.shift();
  let streak = 0;
  for (const day of walk) {
    if (!minutesByDay.get(day)) break;
    streak += 1;
  }

  const monthMinutes = sum(monthStart, today);

  return {
    user: { id: user.id, name: user.name, empId: user.empId },
    date: today,
    weekStart,
    monthStart,
    todayMinutes: minutesByDay.get(today) ?? 0,
    weekMinutes: sum(weekStart, today),
    monthMinutes,
    /** Null rather than 0 when the company has no attendance to compare with. */
    consistency: expected.length ? Math.round((present.length / expected.length) * 100) : null,
    daysPresent: present.length,
    daysExpected: expected.length,
    streak,
    averageMinutes: present.length ? Math.round(monthMinutes / present.length) : 0,
    /** The month to date, for the bar strip. Absent days are included as 0. */
    days: expected.map((day) => ({
      date: day,
      minutes: minutesByDay.get(day) ?? 0,
      present: (minutesByDay.get(day) ?? 0) > 0,
    })),
  };
}
