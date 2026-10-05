import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { liveStatus, presenceOf } from "../../lib/presence";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import type { ClockInInput, ClockOutInput, MyShiftsQuery, RosterQuery } from "./clock.schema";

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

/** The caller's shift in progress, if any. */
async function openShiftFor(companyId: string, userId: string): Promise<ShiftRow | null> {
  return prisma.shift.findFirst({
    where: { companyId, userId, outAt: null },
    select: SHIFT_SELECT,
    orderBy: { inAt: "desc" },
  });
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

  const shift = await prisma.shift.create({
    data: {
      companyId: auth.companyId,
      userId: auth.userId,
      date: input.date,
      inAt: new Date(),
      note: input.note ?? null,
    },
    select: SHIFT_SELECT,
  });

  logger.info({ userId: auth.userId, shiftId: shift.id }, "clocked in");
  return shapeShift(shift);
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
