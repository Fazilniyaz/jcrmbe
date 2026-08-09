import type { MemberRole, Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { embeddedId, nextProjectCode } from "../../lib/codes";
import { isLead, isSuperAdmin, type UserAuth } from "../../middleware/auth";
import { notify } from "../notifications/notifications.service";
import { taskScore } from "../tasks/task.rules";
import type {
  CreateProjectInput,
  ListProjectsQuery,
  PlanInput,
  SecretsInput,
  UpdateProjectInput,
} from "./projects.schema";

/*
 * Projects, and the acceptance flow that governs who can see one.
 *
 * The flow, in the order it has to happen:
 *
 *   1. A superAdmin creates the project and invites a manager or team leader.
 *      That writes ProjectMember{ role: manager, state: invited }.
 *   2. The manager ACCEPTS. Until they do they can see the project but change
 *      nothing about it — `assertCanManage` is what enforces that.
 *   3. An accepted manager invites employees, each ProjectMember{ role: member,
 *      state: invited }.
 *   4. Each employee accepts. Only then does the project appear in their list,
 *      and only then may a task be assigned to them.
 *
 * Visibility is resolved server-side on every read. The client is never sent a
 * project it then has to filter — a list it could filter is a list it could
 * also choose not to filter.
 */

const PROJECT_SELECT = {
  id: true,
  companyId: true,
  name: true,
  description: true,
  state: true,
  code: true,
  client: true,
  clientId: true,
  problemStatement: true,
  solution: true,
  progress: true,
  startDate: true,
  dueDate: true,
  plan: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  state: true,
  invitedById: true,
  invitedAt: true,
  respondedAt: true,
  user: { select: { id: true, name: true, empId: true, email: true, roles: true, tone: true } },
} satisfies Prisma.ProjectMemberSelect;

/* ------------------------------------------------------------ visibility -- */

/**
 * The ids this caller is allowed to see, or `null` for "everything in the
 * company" (superAdmin only).
 *
 * A lead sees a project as soon as they are invited to it — they have to, or
 * they could never find the invitation to accept. Everyone else sees a project
 * only once their own membership is accepted.
 */
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

/** Fetch a project the caller may read, or 404. Never leaks another tenant's ids. */
async function readableProject(auth: UserAuth, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId: auth.companyId },
    select: PROJECT_SELECT,
  });
  if (!project) throw ApiError.notFound("No such project.");

  if (isSuperAdmin(auth)) return project;

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: auth.userId } },
    select: { role: true, state: true },
  });

  const visible = membership && (isLead(auth) || membership.state === "accepted");
  // Same 404 as "no such project": a 403 would confirm the project exists.
  if (!visible) throw ApiError.notFound("No such project.");

  return project;
}

/**
 * Whoever may change the project: the company's superAdmin, or a manager whose
 * membership on THIS project is accepted. An invited-but-not-accepted manager
 * is explicitly not involved yet.
 */
async function assertCanManage(auth: UserAuth, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId: auth.companyId },
    select: PROJECT_SELECT,
  });
  if (!project) throw ApiError.notFound("No such project.");

  if (isSuperAdmin(auth)) return project;

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: auth.userId } },
    select: { role: true, state: true },
  });

  if (!membership) throw ApiError.notFound("No such project.");
  if (membership.role !== "manager") {
    throw ApiError.forbidden("Only the project's manager can change it.");
  }
  if (membership.state !== "accepted") {
    throw ApiError.forbidden("Accept the project first — you aren't involved in it yet.");
  }
  return project;
}

/* -------------------------------------------------------------- progress -- */

/**
 * Progress is the mean of the project's task scores, computed on read.
 *
 * Deliberately not stored: the frontend's whole point is that ticking a
 * checklist line moves the project bar, and a cached number would have to be
 * invalidated by every checklist write to say the same thing.
 */
async function progressFor(projectIds: string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();

  const tasks = await prisma.task.findMany({
    where: { projectIds: { hasSome: projectIds } },
    select: { projectIds: true, checklist: true },
  });

  const totals = new Map<string, { sum: number; count: number }>();
  for (const id of projectIds) totals.set(id, { sum: 0, count: 0 });

  for (const task of tasks) {
    const score = taskScore(task.checklist);
    for (const id of task.projectIds) {
      const bucket = totals.get(id);
      if (!bucket) continue;
      bucket.sum += score;
      bucket.count += 1;
    }
  }

  return new Map(
    [...totals].map(([id, { sum, count }]) => [id, count === 0 ? 0 : Math.round(sum / count)]),
  );
}

/* ------------------------------------------------------------------ list -- */

export async function listProjects(auth: UserAuth, query: ListProjectsQuery) {
  const allowedIds = await visibleProjectIds(auth);

  // A superAdmin asking for "mine" still gets only their own memberships.
  let idFilter = allowedIds;
  if (query.scope === "mine") {
    const mine = await prisma.projectMember.findMany({
      where: { userId: auth.userId, project: { companyId: auth.companyId } },
      select: { projectId: true },
    });
    const mineIds = mine.map((m) => m.projectId);
    idFilter = allowedIds === null ? mineIds : allowedIds.filter((id) => mineIds.includes(id));
  }

  if (idFilter !== null && idFilter.length === 0) return { rows: [], total: 0 };

  const where: Prisma.ProjectWhereInput = {
    companyId: auth.companyId,
    ...(idFilter === null ? {} : { id: { in: idFilter } }),
    ...(query.state ? { state: query.state } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { code: { contains: query.q, mode: "insensitive" } },
            { client: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.project.findMany({
      where,
      select: { ...PROJECT_SELECT, members: { select: MEMBER_SELECT } },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
    prisma.project.count({ where }),
  ]);

  const progress = await progressFor(rows.map((r) => r.id));

  return {
    rows: rows.map((row) => shapeProject(row, row.members, progress.get(row.id) ?? 0, auth)),
    total,
  };
}

/* ------------------------------------------------------------------- get -- */

export async function getProject(auth: UserAuth, id: string) {
  const project = await readableProject(auth, id);

  const [members, tasks, progress] = await Promise.all([
    prisma.projectMember.findMany({ where: { projectId: id }, select: MEMBER_SELECT }),
    prisma.task.findMany({
      where: { companyId: auth.companyId, projectIds: { has: id } },
      select: {
        id: true,
        taskCode: true,
        title: true,
        state: true,
        priority: true,
        priorityLevel: true,
        assigneeIds: true,
        dueDate: true,
        checklist: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    progressFor([id]),
  ]);

  const shaped = shapeProject(project, members, progress.get(id) ?? 0, auth);

  return {
    ...shaped,
    tasks,
    // The vault is staff-only and never reaches a plain member or a client.
    secrets: (await canSeeSecrets(auth, id)) ? await readSecrets(id) : null,
  };
}

/**
 * The wire shape.
 *
 * `assignedEmployees` and `reportTo` are the two id arrays the existing
 * frontend already renders a project with — derived from memberships here so
 * neither side had to change its model: accepted `member` rows are the team,
 * `manager` rows are who it reports to.
 */
function shapeProject(
  project: Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>,
  members: Prisma.ProjectMemberGetPayload<{ select: typeof MEMBER_SELECT }>[],
  progress: number,
  auth: UserAuth,
) {
  const accepted = members.filter((m) => m.state === "accepted");
  const mine = members.find((m) => m.userId === auth.userId);

  return {
    ...project,
    progress,
    members,
    assignedEmployees: accepted.filter((m) => m.role === "member").map((m) => m.userId),
    reportTo: accepted.filter((m) => m.role === "manager").map((m) => m.userId),
    pendingMembers: members.filter((m) => m.state === "invited").map((m) => m.userId),
    myMembership: mine ? { role: mine.role, state: mine.state } : null,
    canManage: isSuperAdmin(auth) || (mine?.role === "manager" && mine.state === "accepted"),
  };
}

/* ---------------------------------------------------------------- create -- */

/*
 * Creating a project used to cost a dozen sequential round trips.
 *
 * It generated the code, created the project, created the creator's membership,
 * then called `inviteMembers` once for managers and again for members — and
 * each of those re-read the project it had just been handed, re-validated
 * against the user table, and then did a findUnique + create PER PERSON before
 * writing notifications. Against a remote database that is where the twenty
 * seconds went; almost none of it was work.
 *
 * A brand-new project cannot have existing members, so none of the per-person
 * reconciliation `inviteMembers` does applies. This validates everyone in one
 * query and writes every membership in one `createMany`.
 */
export async function createProject(auth: UserAuth, input: CreateProjectInput) {
  if (!isLead(auth)) throw ApiError.forbidden("Only an admin or a manager can create a project.");

  if (input.memberIds.length > 0 && !isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can add team members when creating a project.");
  }
  if (input.managerIds.length > 0 && !isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can assign a project manager.");
  }

  /*
   * The creator holds their own manager seat, so they are dropped from
   * `managerIds` rather than invited a second time — ProjectMember is unique on
   * (projectId, userId), and a duplicate in `createMany` would fail the whole
   * batch.
   */
  const managerIds = [...new Set(input.managerIds)].filter((id) => id !== auth.userId);
  const memberIds = [...new Set(input.memberIds)].filter(
    (id) => id !== auth.userId && !managerIds.includes(id),
  );

  // Independent: the code scan and the invitee check touch different
  // collections, so they go together rather than one after the other.
  const [code, invitees] = await Promise.all([
    input.code ? Promise.resolve(input.code) : nextCodeForCompany(auth.companyId),
    fetchInvitees(auth.companyId, [...managerIds, ...memberIds]),
  ]);

  assertInviteesAllowed(invitees, managerIds, "manager");
  assertInviteesAllowed(invitees, memberIds, "member");

  const project = await prisma.project.create({
    data: {
      companyId: auth.companyId,
      name: input.name,
      description: input.description ?? null,
      code,
      client: input.client ?? null,
      clientId: input.clientId ?? null,
      problemStatement: input.problemStatement ?? null,
      solution: input.solution ?? null,
      state: input.state,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      createdById: auth.userId,
      progress: 0,
      plan: [],
      secrets: [],
    },
    select: PROJECT_SELECT,
  });

  const now = new Date();
  await prisma.projectMember.createMany({
    data: [
      // The creator is a manager on it already — and already accepted, since
      // creating something is a stronger signal than accepting it.
      {
        projectId: project.id,
        userId: auth.userId,
        role: "manager" as MemberRole,
        state: "accepted" as const,
        invitedById: auth.userId,
        invitedAt: now,
        respondedAt: now,
      },
      ...managerIds.map((userId) => ({
        projectId: project.id,
        userId,
        role: "manager" as MemberRole,
        state: "invited" as const,
        invitedById: auth.userId,
        invitedAt: now,
      })),
      ...memberIds.map((userId) => ({
        projectId: project.id,
        userId,
        role: "member" as MemberRole,
        state: "invited" as const,
        invitedById: auth.userId,
        invitedAt: now,
      })),
    ],
  });

  const label = `${project.code ? `${project.code} — ` : ""}${project.name}. Accept it to get involved.`;

  // Both notification batches and the membership read-back are independent of
  // each other, so they overlap instead of queueing.
  const [members] = await Promise.all([
    prisma.projectMember.findMany({ where: { projectId: project.id }, select: MEMBER_SELECT }),
    managerIds.length > 0
      ? notify(auth.companyId, managerIds, {
          kind: "project-lead-invited",
          title: `${auth.name} asked you to lead a project`,
          detail: label,
          projectId: project.id,
        })
      : Promise.resolve(),
    memberIds.length > 0
      ? notify(auth.companyId, memberIds, {
          kind: "project-invited",
          title: `${auth.name} added you to a project`,
          detail: label,
          projectId: project.id,
        })
      : Promise.resolve(),
  ]);

  logger.info({ projectId: project.id, companyId: auth.companyId, by: auth.userId }, "project created");

  return shapeProject(project, members, 0, auth);
}

/* ------------------------------------------------------ invitee checks -- */

type Invitee = { id: string; name: string; roles: string[]; empType: string; isOwner: boolean };

/**
 * Every id must be a real, active user in the SAME company.
 *
 * This is the check that stops a crafted id array pulling a stranger into a
 * tenant, so it reads from the user table rather than trusting the request.
 */
async function fetchInvitees(companyId: string, userIds: string[]): Promise<Invitee[]> {
  if (userIds.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, companyId, state: { not: "disabled" } },
    select: { id: true, name: true, roles: true, empType: true, isOwner: true },
  });
  if (users.length !== new Set(userIds).size) {
    throw ApiError.badRequest("One or more of those people aren't in this company.");
  }
  return users;
}

/** The role-specific rules, applied to invitees already proven to be in-tenant. */
function assertInviteesAllowed(all: Invitee[], userIds: string[], role: MemberRole) {
  if (userIds.length === 0) return;
  const ids = new Set(userIds);
  const users = all.filter((u) => ids.has(u.id));

  /*
   * The company owner is never a team member.
   *
   * They already see and manage every project by virtue of being superAdmin, so
   * adding them to the roster would be a no-op that misreports the team size and
   * puts them in the "assigned employees" list of work they are not doing. They
   * can still be a project MANAGER, which is a different thing.
   */
  if (role === "member") {
    const admins = users.filter((u) => u.isOwner || u.roles.includes("superAdmin"));
    if (admins.length > 0) {
      throw ApiError.badRequest(
        "A super admin can't be assigned to a project as a team member — they already have access to every project.",
        { userIds: admins.map((u) => u.id) },
      );
    }
    return;
  }

  const notLeads = users.filter(
    (u) =>
      !u.roles.includes("manager") &&
      !u.roles.includes("teamLeader") &&
      !u.roles.includes("superAdmin") &&
      u.empType === "employee",
  );
  if (notLeads.length > 0) {
    throw ApiError.badRequest("A project can only be led by a manager or a team leader.");
  }
}

async function nextCodeForCompany(companyId: string): Promise<string> {
  const existing = await prisma.project.findMany({
    where: { companyId, code: { not: null } },
    select: { code: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return nextProjectCode(existing.map((p) => p.code ?? ""));
}

/* ---------------------------------------------------------------- update -- */

export async function updateProject(auth: UserAuth, id: string, input: UpdateProjectInput) {
  await assertCanManage(auth, id);

  const data: Prisma.ProjectUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(input.code !== undefined ? { code: input.code ?? null } : {}),
    ...(input.client !== undefined ? { client: input.client ?? null } : {}),
    ...(input.clientId !== undefined ? { clientId: input.clientId ?? null } : {}),
    ...(input.problemStatement !== undefined ? { problemStatement: input.problemStatement ?? null } : {}),
    ...(input.solution !== undefined ? { solution: input.solution ?? null } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate ?? null } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? null } : {}),
  };

  const project = await prisma.project.update({ where: { id }, data, select: PROJECT_SELECT });
  const members = await prisma.projectMember.findMany({ where: { projectId: id }, select: MEMBER_SELECT });
  const progress = await progressFor([id]);

  return shapeProject(project, members, progress.get(id) ?? 0, auth);
}

export async function deleteProject(auth: UserAuth, id: string) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can delete a project.");

  const project = await prisma.project.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true },
  });
  if (!project) throw ApiError.notFound("No such project.");

  // Tasks survive their project and just lose the reference, which is what the
  // frontend's deleteProject did. A task left with no projects at all would be
  // unreachable, so those are removed.
  const tasks = await prisma.task.findMany({
    where: { companyId: auth.companyId, projectIds: { has: id } },
    select: { id: true, projectIds: true },
  });

  const orphaned = tasks.filter((t) => t.projectIds.filter((p) => p !== id).length === 0);
  const detached = tasks.filter((t) => t.projectIds.filter((p) => p !== id).length > 0);

  await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { projectId: id } }),
    prisma.task.deleteMany({ where: { id: { in: orphaned.map((t) => t.id) } } }),
    ...detached.map((task) => {
      const remaining = task.projectIds.filter((p) => p !== id);
      return prisma.task.update({
        where: { id: task.id },
        data: { projectIds: remaining, projectId: remaining[0]! },
      });
    }),
    prisma.project.delete({ where: { id } }),
  ]);

  logger.warn({ projectId: id, by: auth.userId }, "project deleted");
}

/* ------------------------------------------------------------ membership -- */

/**
 * Invite people to a project.
 *
 * Managers may only be invited by a superAdmin — that is step 1 of the flow and
 * a manager cannot appoint their own peer. Members may be invited by a
 * superAdmin or by an accepted manager, which is step 3.
 */
export async function inviteMembers(
  auth: UserAuth,
  projectId: string,
  userIds: string[],
  role: MemberRole,
  options: { skipManageCheck?: boolean } = {},
) {
  if (role === "manager" && !isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can assign a project manager.");
  }

  const project = options.skipManageCheck
    ? await prisma.project.findFirstOrThrow({
        where: { id: projectId, companyId: auth.companyId },
        select: PROJECT_SELECT,
      })
    : await assertCanManage(auth, projectId);

  const users = await fetchInvitees(auth.companyId, userIds);
  assertInviteesAllowed(users, userIds, role);

  const now = new Date();
  const results = await Promise.all(
    users.map(async (user) => {
      const existing = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
        select: { id: true, state: true, role: true },
      });

      if (existing) {
        // Re-inviting someone who declined puts the invitation back in front of
        // them; re-inviting an accepted member is a no-op, not an error.
        if (existing.state === "declined") {
          return prisma.projectMember.update({
            where: { id: existing.id },
            data: { state: "invited", role, invitedById: auth.userId, invitedAt: now, respondedAt: null },
            select: MEMBER_SELECT,
          });
        }
        return prisma.projectMember.findUniqueOrThrow({
          where: { id: existing.id },
          select: MEMBER_SELECT,
        });
      }

      return prisma.projectMember.create({
        data: { projectId, userId: user.id, role, state: "invited", invitedById: auth.userId },
        select: MEMBER_SELECT,
      });
    }),
  );

  await notify(
    auth.companyId,
    results.filter((r) => r.state === "invited").map((r) => r.userId),
    {
      kind: role === "manager" ? "project-lead-invited" : "project-invited",
      title:
        role === "manager"
          ? `${auth.name} asked you to lead a project`
          : `${auth.name} added you to a project`,
      detail: `${project.code ? `${project.code} — ` : ""}${project.name}. Accept it to get involved.`,
      projectId,
    },
  );

  return results;
}

/** The invitee's own answer. Nobody can answer on someone else's behalf. */
export async function respondToInvite(auth: UserAuth, projectId: string, response: "accept" | "decline") {
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId: auth.companyId },
    select: { id: true, name: true, code: true, createdById: true },
  });
  if (!project) throw ApiError.notFound("No such project.");

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: auth.userId } },
    select: { id: true, state: true, role: true, invitedById: true },
  });
  if (!membership) throw ApiError.notFound("You haven't been invited to this project.");
  if (membership.state !== "invited") {
    throw ApiError.conflict(`You have already ${membership.state} this project.`);
  }

  const updated = await prisma.projectMember.update({
    where: { id: membership.id },
    data: { state: response === "accept" ? "accepted" : "declined", respondedAt: new Date() },
    select: MEMBER_SELECT,
  });

  await notify(auth.companyId, [membership.invitedById], {
    kind: response === "accept" ? "project-accepted" : "project-declined",
    title: `${auth.name} ${response === "accept" ? "accepted" : "declined"} a project`,
    detail: `${project.code ? `${project.code} — ` : ""}${project.name}`,
    projectId,
  });

  logger.info({ projectId, userId: auth.userId, response }, "project invitation answered");
  return updated;
}

export async function removeMember(auth: UserAuth, projectId: string, userId: string) {
  // Tenant check FIRST. Reading the membership before proving the project is
  // ours would let a crafted id distinguish "no such member" from "member of a
  // project in someone else's company" by the error it produced.
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId: auth.companyId },
    select: { id: true },
  });
  if (!project) throw ApiError.notFound("No such project.");

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { id: true, role: true },
  });
  if (!membership) throw ApiError.notFound("They aren't on this project.");

  // Removing a manager is a superAdmin decision; removing a member is the
  // project manager's.
  if (membership.role === "manager") {
    if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can remove a project manager.");
  } else {
    await assertCanManage(auth, projectId);
  }

  // Their tasks on this project lose them as an assignee — a task can't be
  // assigned to someone who is no longer on the project.
  const tasks = await prisma.task.findMany({
    where: { companyId: auth.companyId, projectIds: { has: projectId }, assigneeIds: { has: userId } },
    select: { id: true, assigneeIds: true },
  });

  await prisma.$transaction([
    prisma.projectMember.delete({ where: { id: membership.id } }),
    ...tasks.map((task) => {
      const assigneeIds = task.assigneeIds.filter((x) => x !== userId);
      return prisma.task.update({
        where: { id: task.id },
        data: { assigneeIds, assigneeId: assigneeIds[0] ?? null },
      });
    }),
  ]);
}

/** Everything waiting on this person's answer, across every project. */
export async function myInvitations(auth: UserAuth) {
  return prisma.projectMember.findMany({
    where: { userId: auth.userId, state: "invited", project: { companyId: auth.companyId } },
    select: {
      id: true,
      role: true,
      invitedAt: true,
      invitedById: true,
      project: {
        select: { id: true, name: true, code: true, description: true, state: true, dueDate: true },
      },
    },
    orderBy: { invitedAt: "desc" },
  });
}

/* ------------------------------------------------------------------ plan -- */

export async function setPlan(auth: UserAuth, projectId: string, input: PlanInput) {
  await assertCanManage(auth, projectId);

  // Sorted by due date on write, because the plan is a sequence — the frontend
  // sorted on read and this keeps the two in step.
  const plan = [...input.plan]
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((m) => ({
      id: m.id || embeddedId("mst"),
      label: m.label,
      due: new Date(`${m.due}T00:00:00.000Z`),
      status: m.status,
      note: m.note ?? null,
    }));

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { plan },
    select: PROJECT_SELECT,
  });
  return project.plan;
}

/* --------------------------------------------------------------- secrets -- */

/**
 * The vault is for the people who run deployments.
 *
 * Mirrors the frontend's `canSeeSecrets`: never a client, always an admin, and
 * otherwise only a manager or team leader — and here, additionally, only one
 * who is actually on the project.
 */
export async function canSeeSecrets(auth: UserAuth, projectId: string): Promise<boolean> {
  if (auth.roles.includes("client") || auth.roles.includes("vendor")) return false;
  if (isSuperAdmin(auth)) return true;
  if (!auth.roles.includes("manager") && !auth.roles.includes("teamLeader")) return false;

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: auth.userId } },
    select: { state: true },
  });
  return membership?.state === "accepted";
}

async function readSecrets(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { secrets: true },
  });
  return project?.secrets ?? [];
}

export async function getSecrets(auth: UserAuth, projectId: string) {
  await readableProject(auth, projectId);
  if (!(await canSeeSecrets(auth, projectId))) {
    throw ApiError.forbidden("The project vault is limited to project leads.");
  }
  return readSecrets(projectId);
}

export async function setSecrets(auth: UserAuth, projectId: string, input: SecretsInput) {
  await assertCanManage(auth, projectId);
  if (!(await canSeeSecrets(auth, projectId))) {
    throw ApiError.forbidden("The project vault is limited to project leads.");
  }

  const now = new Date();
  const secrets = input.secrets.map((s) => ({
    id: s.id || embeddedId("sec"),
    key: s.key,
    value: s.value,
    env: s.env,
    note: s.note ?? null,
    updatedAt: now,
    updatedBy: auth.name,
  }));

  await prisma.project.update({ where: { id: projectId }, data: { secrets } });
  logger.info({ projectId, by: auth.userId, count: secrets.length }, "project vault updated");
  return secrets;
}
