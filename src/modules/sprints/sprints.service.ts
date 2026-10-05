import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isLead, isSuperAdmin, type UserAuth } from "../../middleware/auth";
import type {
  AssignTasksInput,
  CreateSprintInput,
  ListSprintsQuery,
  UpdateSprintInput,
} from "./sprints.schema";

/*
 * Sprints.
 *
 * A sprint is a lane of a project's board: a name, a window, a goal, and the
 * tasks filed into it. It owns no work of its own — `Task.sprintId` is the
 * only link, so deleting a sprint can never delete a task, and a task always
 * has somewhere to be (the backlog) even when no sprint exists yet.
 *
 * Visibility is INHERITED from the project rather than re-derived here. If you
 * can see a project you can see its sprints; if you cannot, they do not exist
 * as far as you are concerned. Deriving it twice is how the two lists end up
 * disagreeing.
 */

const SPRINT_SELECT = {
  id: true,
  companyId: true,
  projectId: true,
  name: true,
  goal: true,
  state: true,
  tone: true,
  startDate: true,
  endDate: true,
  order: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SprintSelect;

type SprintRow = Prisma.SprintGetPayload<{ select: typeof SPRINT_SELECT }>;

/** Planning the board is a lead's job, the same test teams and projects use. */
function assertCanManage(auth: UserAuth) {
  if (!isLead(auth)) throw ApiError.forbidden("Only a manager or super admin can plan sprints.");
}

/** Projects this caller can see, or null for "every project in the company". */
async function visibleProjectIds(auth: UserAuth): Promise<string[] | null> {
  if (isSuperAdmin(auth)) return null;
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId: auth.userId,
      ...(isLead(auth) ? {} : { state: "accepted" }),
      project: { companyId: auth.companyId },
    },
    select: { projectId: true },
  });
  return [...new Set(memberships.map((m) => m.projectId))];
}

/** The project, if the caller may see it at all. */
async function readableProject(auth: UserAuth, projectId: string) {
  const visible = await visibleProjectIds(auth);
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      companyId: auth.companyId,
      ...(visible === null ? {} : { id: { in: visible } }),
    },
    select: { id: true, name: true, code: true },
  });
  if (!project) throw ApiError.notFound("No such project.");
  return project;
}

/**
 * Sprints, with their task counts.
 *
 * The counts are what the lane headers render ("8 tasks · 3 done"), and they
 * are computed in ONE grouped query rather than per lane — a project with
 * twelve sprints would otherwise cost twelve round trips to draw its header
 * row.
 */
export async function listSprints(auth: UserAuth, queryInput: ListSprintsQuery) {
  const visible = await visibleProjectIds(auth);

  // No memberships and not a super admin: nothing to show. Returning early
  // also avoids `{ in: [] }`, which Mongo treats as "match nothing" but which
  // still costs a round trip.
  if (visible !== null && visible.length === 0) return [];

  const where: Prisma.SprintWhereInput = {
    companyId: auth.companyId,
    ...(queryInput.projectId ? { projectId: queryInput.projectId } : {}),
    ...(visible === null ? {} : { projectId: { in: visible } }),
  };

  const sprints = await prisma.sprint.findMany({
    where,
    select: SPRINT_SELECT,
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });

  if (sprints.length === 0) return [];

  const ids = sprints.map((s) => s.id);
  const [totals, done] = await Promise.all([
    prisma.task.groupBy({
      by: ["sprintId"],
      where: { companyId: auth.companyId, sprintId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ["sprintId"],
      where: { companyId: auth.companyId, sprintId: { in: ids }, state: "done" },
      _count: { _all: true },
    }),
  ]);

  const totalBy = new Map(totals.map((t) => [t.sprintId, t._count._all]));
  const doneBy = new Map(done.map((t) => [t.sprintId, t._count._all]));

  return sprints.map((sprint) => ({
    ...sprint,
    taskCount: totalBy.get(sprint.id) ?? 0,
    doneCount: doneBy.get(sprint.id) ?? 0,
  }));
}

/** Where a new lane goes: after the project's last one. */
async function nextOrder(projectId: string): Promise<number> {
  const last = await prisma.sprint.findFirst({
    where: { projectId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return (last?.order ?? 0) + 1000;
}

export async function createSprint(auth: UserAuth, input: CreateSprintInput) {
  assertCanManage(auth);
  await readableProject(auth, input.projectId);

  const clash = await prisma.sprint.findFirst({
    where: { projectId: input.projectId, name: input.name },
    select: { id: true },
  });
  if (clash) throw ApiError.badRequest("That project already has a sprint with this name.");

  assertWindow(input.startDate, input.endDate);

  const sprint = await prisma.sprint.create({
    data: {
      companyId: auth.companyId,
      projectId: input.projectId,
      name: input.name,
      goal: input.goal ?? null,
      state: input.state,
      tone: input.tone || "violet",
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      order: input.order ?? (await nextOrder(input.projectId)),
      createdById: auth.userId,
    },
    select: SPRINT_SELECT,
  });

  logger.info({ sprintId: sprint.id, projectId: input.projectId, by: auth.userId }, "sprint created");
  return { ...sprint, taskCount: 0, doneCount: 0 };
}

/** A sprint that ends before it starts is a typo, not a plan. */
function assertWindow(start?: Date | null, end?: Date | null) {
  if (start && end && end.getTime() < start.getTime()) {
    throw ApiError.badRequest("A sprint cannot end before it starts.");
  }
}

async function readableSprint(auth: UserAuth, id: string): Promise<SprintRow> {
  const sprint = await prisma.sprint.findFirst({
    where: { id, companyId: auth.companyId },
    select: SPRINT_SELECT,
  });
  if (!sprint) throw ApiError.notFound("No such sprint.");
  // Re-asks the project question rather than trusting the sprint row, so a
  // sprint cannot be a side door into a project you were removed from.
  await readableProject(auth, sprint.projectId);
  return sprint;
}

export async function updateSprint(auth: UserAuth, id: string, input: UpdateSprintInput) {
  assertCanManage(auth);
  const sprint = await readableSprint(auth, id);

  if (input.name && input.name !== sprint.name) {
    const clash = await prisma.sprint.findFirst({
      where: { projectId: sprint.projectId, name: input.name, id: { not: id } },
      select: { id: true },
    });
    if (clash) throw ApiError.badRequest("That project already has a sprint with this name.");
  }

  // Validated against the window the sprint will HAVE, not the one it had —
  // otherwise moving both ends forward in one call rejects a valid pair.
  assertWindow(
    input.startDate !== undefined ? input.startDate : sprint.startDate,
    input.endDate !== undefined ? input.endDate : sprint.endDate,
  );

  const updated = await prisma.sprint.update({
    where: { id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.goal !== undefined ? { goal: input.goal ?? null } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate ?? null } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate ?? null } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    },
    select: SPRINT_SELECT,
  });

  logger.info({ sprintId: id, by: auth.userId }, "sprint updated");
  return updated;
}

/**
 * Delete a sprint. Its tasks go back to the backlog.
 *
 * Never a cascade: the tasks are the work, the sprint is only how it was
 * grouped this month. Losing a plan should not lose the plan's contents.
 */
export async function deleteSprint(auth: UserAuth, id: string) {
  assertCanManage(auth);
  const sprint = await readableSprint(auth, id);

  const [{ count }] = await prisma.$transaction([
    prisma.task.updateMany({ where: { sprintId: id }, data: { sprintId: null } }),
    prisma.sprint.delete({ where: { id } }),
  ]);

  logger.info({ sprintId: id, by: auth.userId, released: count }, "sprint deleted");
  return { id, releasedTasks: count };
}

/**
 * File tasks into a sprint, or send them back to the backlog.
 *
 * Every task must already belong to the sprint's project. That is the one
 * invariant worth enforcing here: a task in a sprint of a project it is not on
 * would show up in a board lane that nobody working on it can open.
 */
export async function assignTasks(auth: UserAuth, input: AssignTasksInput) {
  assertCanManage(auth);

  const sprint = input.sprintId ? await readableSprint(auth, input.sprintId) : null;

  const tasks = await prisma.task.findMany({
    where: { id: { in: input.taskIds }, companyId: auth.companyId },
    select: { id: true, projectIds: true, projectId: true },
  });
  if (tasks.length !== new Set(input.taskIds).size) {
    throw ApiError.notFound("One of those tasks is not in this workspace.");
  }

  if (sprint) {
    const stray = tasks.find(
      (t) => !(t.projectIds.length ? t.projectIds : [t.projectId]).includes(sprint.projectId),
    );
    if (stray) {
      throw ApiError.badRequest("A task can only go in a sprint of a project it belongs to.");
    }
  }

  const { count } = await prisma.task.updateMany({
    where: { id: { in: tasks.map((t) => t.id) } },
    data: { sprintId: input.sprintId },
  });

  logger.info(
    { sprintId: input.sprintId, by: auth.userId, tasks: count },
    input.sprintId ? "tasks filed into sprint" : "tasks returned to backlog",
  );
  return { sprintId: input.sprintId, moved: count };
}
