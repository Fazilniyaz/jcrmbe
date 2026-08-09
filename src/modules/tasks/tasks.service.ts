import type { Prisma, TaskState } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { embeddedId, nextTaskCode } from "../../lib/codes";
import { isLead, isSuperAdmin, type UserAuth } from "../../middleware/auth";
import { notify } from "../notifications/notifications.service";
import {
  clampKra,
  clampScore,
  isOpenState,
  normaliseLine,
  pointsFor,
  priorityFromLevel,
  taskScore,
  type ChecklistLine,
} from "./task.rules";
import type {
  CreateTaskInput,
  ListTasksQuery,
  QcReviewInput,
  UpdateTaskInput,
} from "./tasks.schema";

/*
 * Tasks.
 *
 * Tasks are NOT accepted or declined — accepting the project already implies
 * the obligation, which is why the only membership check here is "is this
 * person an accepted member of a project this task belongs to".
 *
 * Two invariants the service maintains and nothing else may break:
 *
 *   projectId  === projectIds[0]
 *   assigneeId === assigneeIds[0] ?? null
 *
 * The canonical schema is single-valued for both; the frontend is multi-valued.
 * Keeping the primary in step means a query written against either shape agrees
 * with the other.
 */

const TASK_SELECT = {
  id: true,
  companyId: true,
  projectId: true,
  projectIds: true,
  title: true,
  description: true,
  taskCode: true,
  assigneeId: true,
  assigneeIds: true,
  reportToIds: true,
  createdById: true,
  state: true,
  priority: true,
  priorityLevel: true,
  kraPoints: true,
  kraApplied: true,
  checklist: true,
  origin: true,
  updates: true,
  qcReviews: true,
  startDate: true,
  endDate: true,
  dueDate: true,
  prUrl: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true, code: true } },
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

function shapeTask(task: TaskRow) {
  return {
    ...task,
    score: taskScore(task.checklist),
    lastReview: task.qcReviews.at(-1) ?? null,
    reworkCount: task.qcReviews.filter((r) => r.verdict !== "Approved").length,
    // Finished work QC hasn't cleared. A task that comes back from rework and
    // is marked done again re-enters the queue, because its newest review is
    // the rejection rather than an approval.
    awaitingReview: task.state === "done" && task.qcReviews.at(-1)?.verdict !== "Approved",
    signedOff: task.state === "done" && task.qcReviews.at(-1)?.verdict === "Approved",
  };
}

/* ------------------------------------------------------------ visibility -- */

/** Projects this caller can see, or null for "all in the company". */
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

/**
 * A task is visible if it sits on a project the caller can see, OR it is
 * assigned to them. The second clause matters: someone removed from a project
 * still needs to see work they are on until it is reassigned.
 */
async function visibilityWhere(auth: UserAuth): Promise<Prisma.TaskWhereInput> {
  const projectIds = await visibleProjectIds(auth);
  if (projectIds === null) return { companyId: auth.companyId };

  return {
    companyId: auth.companyId,
    OR: [
      ...(projectIds.length > 0 ? [{ projectIds: { hasSome: projectIds } }] : []),
      { assigneeIds: { has: auth.userId } },
      { reportToIds: { has: auth.userId } },
    ],
  };
}

async function readableTask(auth: UserAuth, id: string): Promise<TaskRow> {
  const where = await visibilityWhere(auth);
  const task = await prisma.task.findFirst({ where: { AND: [{ id }, where] }, select: TASK_SELECT });
  if (!task) throw ApiError.notFound("No such task.");
  return task;
}

/** Accepted manager on any of these projects — the "can run this work" test. */
async function isProjectManager(auth: UserAuth, projectIds: readonly string[]): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId: auth.userId,
      projectId: { in: [...projectIds] },
      role: "manager",
      state: "accepted",
    },
    select: { id: true },
  });
  return memberships.length > 0;
}

/** Accepted member OR manager on any of these projects — "is on this team". */
async function isProjectTeam(auth: UserAuth, projectIds: readonly string[]): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  const membership = await prisma.projectMember.findFirst({
    where: {
      userId: auth.userId,
      projectId: { in: [...projectIds] },
      state: "accepted",
    },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * Who may change a task.
 *
 * `full` — retitle, re-scope, reassign, delete: the project's accepted manager
 *          or a superAdmin. Deciding what the work IS.
 * `work` — move state, score a subtask: the above, plus the people actually
 *          delivering it. Doing the work is not the same right as deciding what
 *          the work is.
 *
 * "Delivering it" is deliberately wider than `assigneeIds`. A developer who
 * holds the Tasks module and is an accepted member of the task's project could
 * see the task, open it, and then be refused when they moved it to Done —
 * because the only clause that admitted them was being named an assignee, and
 * plenty of real work is picked up by someone the task was never assigned to.
 * Being on the team that owns the project is the honest test for "may I say
 * this is finished"; naming what the work is stays with the manager.
 */
async function assertCanEdit(auth: UserAuth, task: TaskRow, level: "full" | "work") {
  if (await isProjectManager(auth, task.projectIds)) return;

  if (level === "full") {
    if (task.createdById === auth.userId) return;
    throw ApiError.forbidden(
      "Only the project's manager can change what this task is. You can still move its status and score its subtasks.",
    );
  }

  if (task.assigneeIds.includes(auth.userId)) return;
  // Supervising the task counts too — reportTo is who the work answers to.
  if (task.reportToIds.includes(auth.userId)) return;
  if (await isProjectTeam(auth, task.projectIds)) return;

  throw ApiError.forbidden(
    "You're not on this task's project, so you can't change its status.",
  );
}

/**
 * Assignees have to be accepted members of a project the task is on.
 *
 * This is where "no acceptance on tasks" is made safe: the obligation comes
 * from the project, so a task cannot be pushed onto someone who never accepted
 * the project it belongs to.
 */
async function assertAssignable(auth: UserAuth, projectIds: string[], userIds: string[]) {
  if (userIds.length === 0) return;

  const members = await prisma.projectMember.findMany({
    where: {
      projectId: { in: projectIds },
      userId: { in: userIds },
      state: "accepted",
      project: { companyId: auth.companyId },
    },
    select: { userId: true },
  });

  const accepted = new Set(members.map((m) => m.userId));
  const missing = userIds.filter((id) => !accepted.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(
      "A task can only be assigned to people who have accepted the project.",
      { userIds: missing },
    );
  }
}

async function assertProjectsWritable(auth: UserAuth, projectIds: string[]) {
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, companyId: auth.companyId },
    select: { id: true },
  });
  if (projects.length !== new Set(projectIds).size) {
    throw ApiError.badRequest("One or more of those projects don't exist in this company.");
  }
  if (!(await isProjectManager(auth, projectIds))) {
    throw ApiError.forbidden("Only an accepted project manager can create work on a project.");
  }
}

/* ------------------------------------------------------------------ list -- */

export async function listTasks(auth: UserAuth, query: ListTasksQuery) {
  const visibility = await visibilityWhere(auth);

  const where: Prisma.TaskWhereInput = {
    AND: [
      visibility,
      ...(query.state ? [{ state: query.state }] : []),
      ...(query.projectId ? [{ projectIds: { has: query.projectId } }] : []),
      ...(query.assigneeId ? [{ assigneeIds: { has: query.assigneeId } }] : []),
      ...(query.scope === "mine" ? [{ assigneeIds: { has: auth.userId } }] : []),
      // The QC queue: everything marked done. Whether it is still awaiting
      // review depends on the newest verdict, which is an embedded array and
      // therefore filtered after the read.
      ...(query.scope === "review" ? [{ state: "done" as TaskState }] : []),
      ...(query.scope === "bugs" ? [{ origin: { isNot: null } }] : []),
      ...(query.q
        ? [
            {
              OR: [
                { title: { contains: query.q, mode: "insensitive" as const } },
                { taskCode: { contains: query.q, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      select: TASK_SELECT,
      orderBy: [{ priorityLevel: "asc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
    prisma.task.count({ where }),
  ]);

  const shaped = rows.map(shapeTask);
  return {
    rows: query.scope === "review" ? shaped.filter((t) => t.awaitingReview) : shaped,
    total,
  };
}

export async function getTask(auth: UserAuth, id: string) {
  return shapeTask(await readableTask(auth, id));
}

/* ---------------------------------------------------------------- create -- */

export async function createTask(auth: UserAuth, input: CreateTaskInput) {
  const projectIds = [...new Set(input.projectIds)];
  await assertProjectsWritable(auth, projectIds);

  const assigneeIds = [...new Set(input.assigneeIds)];
  await assertAssignable(auth, projectIds, assigneeIds);

  const checklist = input.checklist.map((line) =>
    normaliseLine({ ...line, id: line.id || embeddedId("chk") }),
  );

  const task = await prisma.task.create({
    data: {
      companyId: auth.companyId,
      projectId: projectIds[0]!,
      projectIds,
      title: input.title,
      description: input.description ?? null,
      taskCode: input.taskCode ?? (await nextCodeForCompany(auth.companyId)),
      assigneeId: assigneeIds[0] ?? null,
      assigneeIds,
      reportToIds: [...new Set(input.reportToIds)],
      createdById: auth.userId,
      state: input.state,
      priority: priorityFromLevel(input.priorityLevel),
      priorityLevel: input.priorityLevel,
      kraPoints: input.kraPoints,
      kraApplied: false,
      checklist,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      dueDate: input.dueDate ?? null,
      prUrl: input.prUrl ?? null,
      ...(input.origin
        ? {
            origin: {
              kind: input.origin.kind,
              severity: input.origin.severity,
              raisedBy: auth.name,
              raisedByUserId: auth.userId,
              foundIn: input.origin.foundIn ?? null,
            },
          }
        : {}),
    },
    select: TASK_SELECT,
  });

  await refreshOpenWork(assigneeIds);

  await notify(auth.companyId, assigneeIds, {
    kind: "task-assigned",
    title: `${auth.name} assigned a task to you`,
    detail: `${task.taskCode ?? ""} — ${task.title}`.trim(),
    taskId: task.id,
    projectId: task.projectId,
  });

  logger.info({ taskId: task.id, companyId: auth.companyId, by: auth.userId }, "task created");
  return shapeTask(task);
}

async function nextCodeForCompany(companyId: string): Promise<string> {
  const existing = await prisma.task.findMany({
    where: { companyId, taskCode: { not: null } },
    select: { taskCode: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return nextTaskCode(existing.map((t) => t.taskCode ?? ""));
}

/* ---------------------------------------------------------------- update -- */

export async function updateTask(auth: UserAuth, id: string, input: UpdateTaskInput) {
  const before = await readableTask(auth, id);

  // Anything that changes what the work IS needs manager rights; scoring the
  // checklist or moving the state does not.
  const structural =
    input.title !== undefined ||
    input.description !== undefined ||
    input.projectIds !== undefined ||
    input.assigneeIds !== undefined ||
    input.reportToIds !== undefined ||
    input.kraPoints !== undefined ||
    input.taskCode !== undefined ||
    input.priorityLevel !== undefined ||
    input.origin !== undefined;

  await assertCanEdit(auth, before, structural ? "full" : "work");

  const projectIds = input.projectIds ? [...new Set(input.projectIds)] : before.projectIds;
  if (input.projectIds) await assertProjectsWritable(auth, projectIds);

  const assigneeIds = input.assigneeIds ? [...new Set(input.assigneeIds)] : before.assigneeIds;
  if (input.assigneeIds) await assertAssignable(auth, projectIds, assigneeIds);

  const checklist = input.checklist
    ? input.checklist.map((line) => normaliseLine({ ...line, id: line.id || embeddedId("chk") }))
    : undefined;

  const trail = input.note
    ? [
        ...before.updates,
        { id: embeddedId("upd"), at: new Date(), by: auth.name, summary: input.note },
      ]
    : before.updates;

  const stateChanged = input.state !== undefined && input.state !== before.state;

  const task = await prisma.task.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.taskCode !== undefined ? { taskCode: input.taskCode ?? null } : {}),
      ...(input.projectIds ? { projectIds, projectId: projectIds[0]! } : {}),
      ...(input.assigneeIds ? { assigneeIds, assigneeId: assigneeIds[0] ?? null } : {}),
      ...(input.reportToIds ? { reportToIds: [...new Set(input.reportToIds)] } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.priorityLevel !== undefined
        ? { priorityLevel: input.priorityLevel, priority: priorityFromLevel(input.priorityLevel) }
        : {}),
      ...(input.kraPoints !== undefined ? { kraPoints: input.kraPoints } : {}),
      ...(checklist ? { checklist } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate ?? null } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate ?? null } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? null } : {}),
      ...(input.prUrl !== undefined ? { prUrl: input.prUrl ?? null } : {}),
      ...(stateChanged && input.state === "done" ? { completedAt: new Date() } : {}),
      ...(stateChanged && input.state !== "done" ? { completedAt: null } : {}),
      ...(input.note ? { updates: trail } : {}),
    },
    select: TASK_SELECT,
  });

  // Someone added by an edit is being assigned the task just the same as on
  // create, so they get the same notification. People already on it are not
  // re-notified.
  const added = assigneeIds.filter((x) => !before.assigneeIds.includes(x));
  if (added.length > 0) {
    await notify(auth.companyId, added, {
      kind: "task-assigned",
      title: `${auth.name} assigned a task to you`,
      detail: `${task.taskCode ?? ""} — ${task.title}`.trim(),
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  await refreshOpenWork([...new Set([...before.assigneeIds, ...assigneeIds])]);

  // The spec's secondary KRA rule, kept dormant behind kraApplied: the frontend
  // never sets `failed`, so this only fires if something deliberately does.
  if (stateChanged && input.state === "failed") {
    await applyFailureDeduction(auth, task);
  }

  return shapeTask(await prisma.task.findUniqueOrThrow({ where: { id }, select: TASK_SELECT }));
}

export async function deleteTask(auth: UserAuth, id: string) {
  const task = await readableTask(auth, id);
  await assertCanEdit(auth, task, "full");

  await prisma.task.delete({ where: { id } });
  await refreshOpenWork(task.assigneeIds);

  logger.warn({ taskId: id, by: auth.userId }, "task deleted");
}

/* ------------------------------------------------------------- checklist -- */

/** Score one line. Open to assignees, which is the whole point of the module. */
export async function scoreChecklistItem(
  auth: UserAuth,
  taskId: string,
  itemId: string,
  input: { score?: number; done?: boolean },
) {
  const task = await readableTask(auth, taskId);
  await assertCanEdit(auth, task, "work");

  const found = task.checklist.find((c) => c.id === itemId);
  if (!found) throw ApiError.notFound("No such checklist line.");

  const score = clampScore(input.score ?? (input.done ? 1 : 0));
  const checklist: ChecklistLine[] = task.checklist.map((line) =>
    line.id === itemId ? normaliseLine({ ...line, score }) : normaliseLine(line),
  );

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { checklist },
    select: TASK_SELECT,
  });
  return shapeTask(updated);
}

/* ------------------------------------------------------------- QC review -- */

/** The audit-trail line for a verdict, worded as the frontend words it. */
function describeReview(
  verdict: QcReviewInput["verdict"],
  lines: number,
  pointsDeducted: number,
  assigneeCount: number,
): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (verdict === "Approved") return "QC approved the checklist — task signed off.";
  if (verdict === "Corrections") {
    return `QC requested corrections on ${plural(lines, "line")} — back to In Progress, no KRA change.`;
  }
  return (
    `QC marked ${plural(lines, "line")} as errors. ` +
    `${pointsDeducted} KRA ${pointsDeducted === 1 ? "point" : "points"} deducted from ` +
    `${plural(assigneeCount, "assignee")} — back to In Progress.`
  );
}

/**
 * Commit a QC verdict and its KRA consequence, atomically.
 *
 * This is the frontend's rule, unchanged:
 *
 *   - Only an Error costs anything. Corrections is a nudge, not a penalty.
 *   - The cost is the sum of the POINTS on the flagged checklist lines.
 *   - EVERY assignee takes the FULL deduction. It is not split between them:
 *     two people on a task worth 4 points lose 4 each.
 *   - A rejected verdict sends the task back to In Progress and resets the
 *     flagged lines to zero, so there is something concrete to redo.
 *
 * The task update, the KRA moves and the KraEvent rows are one transaction —
 * a half-applied review would leave points deducted with no record of why.
 * The deduction is computed from the STORED checklist, never from the request.
 */
export async function submitQcReview(auth: UserAuth, taskId: string, input: QcReviewInput) {
  const task = await readableTask(auth, taskId);

  // QC sign-off is for the QC role and the people running the project.
  const canReview =
    auth.roles.includes("qualityCheck") || (await isProjectManager(auth, task.projectIds));
  if (!canReview) throw ApiError.forbidden("Only QC or the project's manager can review a task.");

  const validIds = new Set(task.checklist.map((c) => c.id));
  const failedItemIds = [...new Set(input.failedItemIds)].filter((id) => validIds.has(id));

  // Only Error needs something flagged, and only because the flagged subtasks'
  // points ARE the deduction. Corrections may name subtasks or not; either way
  // it costs nothing. Checked after filtering so ids for another task's
  // subtasks are caught here rather than silently deducting zero.
  if (input.verdict === "Error" && failedItemIds.length === 0) {
    throw ApiError.badRequest(
      "Flag at least one subtask to record an error — its points are what gets deducted.",
    );
  }

  // The single rule this whole flow turns on: nothing but Error moves KRA.
  const deduction = input.verdict === "Error" ? pointsFor(task.checklist, failedItemIds) : 0;

  const assignees =
    deduction > 0 && task.assigneeIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: task.assigneeIds }, companyId: auth.companyId },
          select: { id: true, kra: true },
        })
      : [];

  const affected = assignees.map((user) => ({
    userId: user.id,
    from: user.kra,
    to: clampKra(user.kra - deduction),
  }));

  const now = new Date();
  const review = {
    id: embeddedId("qc"),
    at: now,
    by: auth.name,
    byUserId: auth.userId,
    verdict: input.verdict,
    note: input.note ?? null,
    failedItemIds,
    pointsDeducted: deduction,
    affected,
  };

  const sendBack = input.verdict !== "Approved";
  const failed = new Set(failedItemIds);

  const checklist = task.checklist.map((line) =>
    normaliseLine(sendBack && failed.has(line.id) ? { ...line, score: 0 } : line),
  );

  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: {
        ...(sendBack ? { state: "inProgress" as TaskState, completedAt: null } : {}),
        checklist,
        qcReviews: [...task.qcReviews, review],
        updates: [
          ...task.updates,
          {
            id: embeddedId("upd"),
            at: now,
            by: auth.name,
            summary: describeReview(input.verdict, failedItemIds.length, deduction, task.assigneeIds.length),
          },
        ],
        // Marks that this task has cost KRA once. Guards the failure path below
        // from deducting a second time for the same piece of work.
        ...(deduction > 0 ? { kraApplied: true } : {}),
      },
    }),
    ...affected.map((a) =>
      prisma.user.update({ where: { id: a.userId }, data: { kra: a.to } }),
    ),
    ...affected
      .filter((a) => a.from !== a.to)
      .map((a) =>
        prisma.kraEvent.create({
          data: {
            companyId: auth.companyId,
            userId: a.userId,
            taskId,
            delta: a.to - a.from,
            reason: `QC error on ${task.taskCode ?? task.title}${input.note ? ` — ${input.note}` : ""}`,
            balanceAfter: a.to,
          },
        }),
      ),
  ]);

  // Every assignee hears the outcome, whichever way it went — same wording as
  // the frontend used.
  const label = `${task.taskCode ?? ""} — ${task.title}`.trim();
  const outcome = {
    Approved: {
      kind: "qc-approved",
      title: "Your task was approved by QC",
      detail: `${label} passed review${input.note ? `. “${input.note}”` : "."}`,
    },
    Corrections: {
      kind: "qc-corrections",
      title: "QC returned your task for corrections",
      detail: `${label} is back In Progress. No KRA change${input.note ? `. “${input.note}”` : "."}`,
    },
    Error: {
      kind: "qc-error",
      title: "QC marked errors on your task",
      detail: `${label} is back In Progress. ${deduction} KRA point${deduction === 1 ? "" : "s"} deducted${input.note ? `. “${input.note}”` : "."}`,
    },
  }[input.verdict];

  await notify(auth.companyId, task.assigneeIds, { ...outcome, taskId, projectId: task.projectId });
  await refreshOpenWork(task.assigneeIds);

  logger.info(
    { taskId, verdict: input.verdict, deduction, affected: affected.length, by: auth.userId },
    "qc review recorded",
  );

  return shapeTask(await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: TASK_SELECT }));
}

/* --------------------------------------------------------- failure path -- */

/**
 * The spec's default KRA rule, kept as a secondary path.
 *
 * The frontend's rule is the QC verdict above, and that is what normally moves
 * KRA. This fires only when a task is explicitly moved to `failed`, deducts the
 * task's own `kraPoints` once, and is guarded by `kraApplied` so a task that has
 * already cost points through QC cannot be charged for twice.
 */
async function applyFailureDeduction(auth: UserAuth, task: TaskRow) {
  if (task.kraApplied || task.kraPoints <= 0 || task.assigneeIds.length === 0) return;

  const assignees = await prisma.user.findMany({
    where: { id: { in: task.assigneeIds }, companyId: auth.companyId },
    select: { id: true, kra: true },
  });

  await prisma.$transaction([
    prisma.task.update({ where: { id: task.id }, data: { kraApplied: true } }),
    ...assignees.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: { kra: clampKra(user.kra - task.kraPoints) },
      }),
    ),
    ...assignees.map((user) =>
      prisma.kraEvent.create({
        data: {
          companyId: auth.companyId,
          userId: user.id,
          taskId: task.id,
          delta: clampKra(user.kra - task.kraPoints) - user.kra,
          reason: `Task marked failed: ${task.taskCode ?? task.title}`,
          balanceAfter: clampKra(user.kra - task.kraPoints),
        },
      }),
    ),
  ]);

  logger.warn({ taskId: task.id, points: task.kraPoints }, "KRA deducted for failed task");
}

/* --------------------------------------------------------------- counts -- */

/**
 * Keep `User.openWork` true.
 *
 * It is a denormalised count that the roster and the dashboards read, so it is
 * recomputed from the tasks themselves after anything that could change it
 * rather than incremented — an increment that misses one path drifts forever.
 */
async function refreshOpenWork(userIds: readonly string[]) {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return;

  /*
   * ONE query for everybody, not one per person.
   *
   * This runs after every task write, and a task with six assignees was costing
   * six full table scans plus six updates before the response could be sent —
   * which is most of why a board felt slow to settle after a change.
   */
  const tasks = await prisma.task.findMany({
    where: { assigneeIds: { hasSome: [...unique] } },
    select: { assigneeIds: true, state: true },
  });

  const counts = new Map<string, number>(unique.map((id) => [id, 0]));
  for (const task of tasks) {
    if (!isOpenState(task.state)) continue;
    for (const id of task.assigneeIds) {
      const current = counts.get(id);
      if (current !== undefined) counts.set(id, current + 1);
    }
  }

  await Promise.all(
    [...counts].map(([userId, openWork]) =>
      prisma.user
        .update({ where: { id: userId }, data: { openWork } })
        .catch(() => undefined), // the user may have just been deleted
    ),
  );
}
