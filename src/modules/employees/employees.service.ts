import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { withEmpId } from "../../lib/empId";
import { INVITE_TTL_MS, issueToken } from "../../lib/tokens";
import { employeeInviteMail, queueMail } from "../../lib/mailer";
import { inviteUrl } from "../companies/companies.service";
import { scopedBranchId } from "../branches/branches.service";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import type { CreateEmployeeInput, ListEmployeesQuery, UpdateEmployeeInput } from "./employees.schema";

/*
 * Employees.
 *
 * Every query below starts from `companyId: auth.companyId`. That value comes
 * from the verified token via requireAuth and can never be supplied by the
 * caller, so cross-tenant reads are not a check that can be forgotten — there is
 * no code path that omits it.
 */

const EMPLOYEE_SELECT = {
  id: true,
  companyId: true,
  name: true,
  email: true,
  empId: true,
  roles: true,
  empType: true,
  empStatus: true,
  currentStatus: true,
  kra: true,
  openWork: true,
  isOwner: true,
  state: true,
  moduleAccess: true,
  branchId: true,
  branch: { select: { id: true, name: true, isHead: true } },
  reportsToId: true,
  reportsTo: { select: { id: true, name: true, empId: true } },
  phone: true,
  tone: true,
  joinedAt: true,
  updatedAt: true,
  lastLoginAt: true,
  inviteExpiresAt: true,
  inviteTokenHash: true,
} satisfies Prisma.UserSelect;

type EmployeeRow = Prisma.UserGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

/**
 * Strips the token hash and flattens the branch to a name, which is the shape
 * the existing Employees UI already renders (`Employee.branch` is a string).
 */
export function toEmployee(row: EmployeeRow) {
  const { inviteTokenHash, branch, reportsTo, ...rest } = row;
  return {
    ...rest,
    branch: branch?.name ?? null,
    branchIsHead: branch?.isHead ?? false,
    reportsTo: reportsTo ?? null,
    invitePending: Boolean(inviteTokenHash),
    inviteExpired: Boolean(inviteTokenHash && row.inviteExpiresAt && row.inviteExpiresAt <= new Date()),
  };
}

/* ------------------------------------------------------------ authority -- */

/**
 * Who may change this person's record.
 *
 * Having the Employees module IS the authorisation — that is what the module
 * grant means, and layering a second role test on top made the grant a lie: a
 * manager could open the module and then be refused every write in it.
 *
 * Two things the module does not buy, whoever holds it:
 *   - the company owner's record (see below)
 *   - your own privileged fields (see `assertSelfEditAllowed`)
 */
async function assertCanWrite(auth: UserAuth, targetId: string): Promise<EmployeeRow> {
  const target = await prisma.user.findFirst({
    where: { id: targetId, companyId: auth.companyId },
    select: EMPLOYEE_SELECT,
  });
  // Same answer for "not in your company" and "does not exist": a 403 here
  // would confirm the id belongs to some other tenant.
  if (!target) throw ApiError.notFound("No such employee.");

  if (isSuperAdmin(auth)) return target;

  // The owner is the one account that can restore any other, so it is never
  // editable by someone who is not it.
  if (target.isOwner) throw ApiError.forbidden("Only the account owner can change that record.");

  return target;
}

/**
 * Roles.
 *
 * Anyone who can write to the record can set ordinary roles — that is the whole
 * point of the Employees module. `superAdmin` is the exception and is refused
 * for everyone, including a superAdmin: it belongs to the company owner and is
 * granted once, at company creation, by the master. Nothing else hands it out.
 */
function assertRoleChangeAllowed(_auth: UserAuth, roles: readonly string[] | undefined) {
  if (!roles) return;
  if (roles.includes("superAdmin")) {
    throw ApiError.forbidden(
      "The super admin role belongs to the company owner and can't be granted here.",
    );
  }
}

/**
 * The only fields anyone may change on their OWN record here.
 *
 * Without this a manager — who legitimately has the Employees module and passes
 * the "can I write to my own row" test — could PATCH their own `kra` back to
 * 100 and erase every QC deduction against them, or flip their own `empStatus`.
 * Self-service belongs in Settings, and Settings only exposes name, phone and
 * avatar colour. A superAdmin is exempt: they can already grant themselves
 * anything, so restricting them would be theatre rather than a control.
 */
const SELF_EDITABLE = new Set(["name", "phone", "tone", "currentStatus"]);

function assertSelfEditAllowed(auth: UserAuth, targetId: string, input: UpdateEmployeeInput) {
  if (isSuperAdmin(auth) || targetId !== auth.userId) return;

  const forbidden = Object.keys(input).filter(
    (key) => input[key as keyof UpdateEmployeeInput] !== undefined && !SELF_EDITABLE.has(key),
  );
  if (forbidden.length > 0) {
    throw new ApiError(
      403,
      "forbidden",
      "You can only change your own name, phone, avatar colour and availability.",
      { fields: forbidden },
    );
  }
}

/* --------------------------------------------------------------- branch -- */

/**
 * Resolve a branch for this company, creating it if the name is new.
 *
 * Branch names are free text in the existing UI, so a name that has never been
 * seen has to become a branch rather than an error — otherwise saving an
 * employee would fail on a typo the old build accepted.
 */
async function resolveBranchId(
  companyId: string,
  input: { branchId?: string; branch?: string },
): Promise<string | null | undefined> {
  if (input.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: input.branchId, companyId },
      select: { id: true },
    });
    if (!branch) throw ApiError.badRequest("No such branch.");
    return branch.id;
  }

  if (input.branch === undefined) return undefined; // field not supplied — leave it
  if (input.branch === "") return null;

  const existing = await prisma.branch.findFirst({
    where: { companyId, name: { equals: input.branch, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.branch.create({
    data: { companyId, name: input.branch, isHead: false },
    select: { id: true },
  });
  return created.id;
}

/** reportsTo must be someone in the same company, and never the person themselves. */
async function resolveReportsTo(
  companyId: string,
  selfId: string | null,
  reportsToId: string | null | undefined,
): Promise<string | null | undefined> {
  if (reportsToId === undefined) return undefined;
  if (reportsToId === null) return null;
  if (selfId && reportsToId === selfId) throw ApiError.badRequest("Someone can't report to themselves.");

  const manager = await prisma.user.findFirst({
    where: { id: reportsToId, companyId },
    select: { id: true },
  });
  if (!manager) throw ApiError.badRequest("No such manager in this company.");
  return manager.id;
}

/* ----------------------------------------------------------------- list -- */

export async function listEmployees(auth: UserAuth, query: ListEmployeesQuery) {
  const where: Prisma.UserWhereInput = {
    companyId: auth.companyId,
    ...(query.role ? { roles: { has: query.role } } : {}),
    ...(query.state ? { state: query.state } : {}),
    ...(query.currentStatus ? { currentStatus: query.currentStatus } : {}),
    ...(query.branch ? { branch: { is: { name: { equals: query.branch, mode: "insensitive" } } } } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
            { empId: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: EMPLOYEE_SELECT,
      orderBy: [{ joinedAt: "desc" }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
    prisma.user.count({ where }),
  ]);

  return { rows: rows.map(toEmployee), total };
}

/* ------------------------------------------------------------------ get -- */

export async function getEmployee(auth: UserAuth, id: string) {
  const row = await prisma.user.findFirst({
    where: { id, companyId: auth.companyId },
    select: EMPLOYEE_SELECT,
  });
  if (!row) throw ApiError.notFound("No such employee.");

  const [memberships, tasks, kraEvents] = await Promise.all([
    prisma.projectMember.findMany({
      where: { userId: id, project: { companyId: auth.companyId } },
      select: {
        id: true,
        role: true,
        state: true,
        invitedAt: true,
        respondedAt: true,
        project: { select: { id: true, name: true, code: true, state: true, dueDate: true } },
      },
      orderBy: { invitedAt: "desc" },
    }),
    prisma.task.findMany({
      where: { companyId: auth.companyId, assigneeIds: { has: id } },
      select: {
        id: true,
        taskCode: true,
        title: true,
        state: true,
        priority: true,
        priorityLevel: true,
        dueDate: true,
        kraPoints: true,
        checklist: true,
        project: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.kraEvent.findMany({
      where: { userId: id, companyId: auth.companyId },
      select: { id: true, delta: true, reason: true, balanceAfter: true, taskId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    ...toEmployee(row),
    // Derived, never stored — computed here so two clients can't disagree.
    acceptedProjects: memberships.filter((m) => m.state === "accepted"),
    invitedProjects: memberships.filter((m) => m.state === "invited"),
    assignedTasks: tasks,
    openTaskCount: tasks.filter((t) => t.state !== "done").length,
    kraEvents,
  };
}

/* --------------------------------------------------------------- create -- */

export async function createEmployee(auth: UserAuth, input: CreateEmployeeInput) {
  // No extra role gate: reaching this route already required the Employees
  // module, and that grant is the authorisation.
  assertRoleChangeAllowed(auth, input.roles);

  const duplicate = await prisma.user.findFirst({
    where: { companyId: auth.companyId, email: input.email },
    select: { id: true },
  });
  if (duplicate) throw ApiError.conflict("Someone in this company already uses that email address.");

  /*
   * Where a new joiner lands when the form didn't say.
   *
   * The branch the workspace is CURRENTLY SCOPED TO — not the head office.
   * Getting this wrong is what made a new employee appear to vanish: an admin
   * working in a pinned branch adds someone, the person is filed under the head
   * office instead, and the scoped list they were just looking at correctly
   * excludes them. The row existed; it was simply somewhere else.
   *
   * Falls back to the head office when the scope is "all branches", because
   * leaving the branch null would hide them from every scoped view at once.
   */
  const branchId =
    (await resolveBranchId(auth.companyId, input)) ?? (await scopedBranchId(auth.companyId));

  // Whoever adds someone becomes their reporting line unless another was named.
  const reportsToId =
    (await resolveReportsTo(auth.companyId, null, input.reportsToId)) ??
    (isSuperAdmin(auth) ? null : auth.userId);

  const invite = input.sendInvite ? issueToken(INVITE_TTL_MS) : null;

  const row = await withEmpId(input.empId, (empId) =>
    prisma.user.create({
      data: {
        companyId: auth.companyId,
        name: input.name,
        email: input.email,
        empId,
        roles: input.roles,
        empType: input.empType,
        empStatus: input.empStatus,
        currentStatus: input.currentStatus,
        kra: input.kra,
        openWork: input.openWork,
        branchId: branchId ?? null,
        reportsToId: reportsToId ?? null,
        phone: input.phone ?? null,
        tone: input.tone,
        state: "invited",
        ...(invite ? { inviteTokenHash: invite.tokenHash, inviteExpiresAt: invite.expiresAt } : {}),
      },
      select: EMPLOYEE_SELECT,
    }),
  );

  let inviteResult: { queued: boolean; expiresAt: Date; url?: string } | null = null;

  if (invite) {
    const company = await prisma.company.findUnique({
      where: { id: auth.companyId },
      select: { companyName: true },
    });
    const url = inviteUrl(invite.token);
    // Queued, not awaited: the row is created and the response goes back now.
    const { queued } = queueMail(
      employeeInviteMail({
        to: input.email,
        name: input.name,
        companyName: company?.companyName ?? "Jadvix",
        url,
      }),
    );
    inviteResult = { queued, expiresAt: invite.expiresAt, ...(env.mailEnabled ? {} : { url }) };
  }

  logger.info({ userId: row.id, companyId: auth.companyId, by: auth.userId }, "employee created");
  return { employee: toEmployee(row), invite: inviteResult };
}

/* --------------------------------------------------------------- update -- */

export async function updateEmployee(auth: UserAuth, id: string, input: UpdateEmployeeInput) {
  const target = await assertCanWrite(auth, id);
  assertSelfEditAllowed(auth, id, input);
  assertRoleChangeAllowed(auth, input.roles);

  if (input.email && input.email !== target.email) {
    const duplicate = await prisma.user.findFirst({
      where: { companyId: auth.companyId, email: input.email, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) throw ApiError.conflict("Someone in this company already uses that email address.");
  }

  // The owner must always keep superAdmin and must never be disabled, or the
  // tenant locks itself out with no way back in.
  if (target.isOwner) {
    if (input.roles && !input.roles.includes("superAdmin")) {
      throw ApiError.badRequest("The account owner must keep the super admin role.");
    }
    if (input.state && input.state !== "active") {
      throw ApiError.badRequest("The account owner can't be disabled.");
    }
  }

  const branchId = await resolveBranchId(auth.companyId, input);
  const reportsToId = await resolveReportsTo(auth.companyId, id, input.reportsToId);

  const data: Prisma.UserUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.empId !== undefined ? { empId: input.empId } : {}),
    ...(input.roles !== undefined ? { roles: input.roles } : {}),
    ...(input.empType !== undefined ? { empType: input.empType } : {}),
    ...(input.empStatus !== undefined ? { empStatus: input.empStatus } : {}),
    ...(input.currentStatus !== undefined ? { currentStatus: input.currentStatus } : {}),
    ...(input.kra !== undefined ? { kra: input.kra } : {}),
    ...(input.openWork !== undefined ? { openWork: input.openWork } : {}),
    ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
    ...(input.tone !== undefined ? { tone: input.tone } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(branchId !== undefined ? { branch: branchId ? { connect: { id: branchId } } : { disconnect: true } } : {}),
    ...(reportsToId !== undefined
      ? { reportsTo: reportsToId ? { connect: { id: reportsToId } } : { disconnect: true } }
      : {}),
  };

  const row = await prisma.user.update({ where: { id }, data, select: EMPLOYEE_SELECT });

  // Disabling someone has to end their sessions immediately.
  if (input.state === "disabled") {
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ userId: id, by: auth.userId }, "employee disabled — sessions revoked");
  }

  return toEmployee(row);
}

/** The header status control — always about the caller's own record. */
export async function setOwnStatus(auth: UserAuth, currentStatus: CreateEmployeeInput["currentStatus"]) {
  const row = await prisma.user.update({
    where: { id: auth.userId },
    data: { currentStatus },
    select: EMPLOYEE_SELECT,
  });
  return toEmployee(row);
}

/* --------------------------------------------------------------- delete -- */

/**
 * Remove someone, and pull them off everything they were on.
 *
 * Mirrors the frontend's `deleteEmployee`: project memberships go, task
 * assignments lose them, and the work itself survives. A task whose primary
 * assignee was the deleted person is re-pointed at the next assignee, or left
 * unassigned — never left pointing at a row that no longer exists.
 */
export async function deleteEmployee(auth: UserAuth, id: string) {
  // The Employees module authorises this, like every other write in it. The two
  // guards below are about integrity, not privilege: removing the owner would
  // orphan the tenant, and removing yourself would sign you out of a company
  // you may be the only administrator of.
  const target = await prisma.user.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true, isOwner: true },
  });
  if (!target) throw ApiError.notFound("No such employee.");
  if (target.isOwner) throw ApiError.badRequest("The account owner can't be removed.");
  if (target.id === auth.userId) throw ApiError.badRequest("You can't remove your own account.");

  const tasks = await prisma.task.findMany({
    where: { companyId: auth.companyId, OR: [{ assigneeIds: { has: id } }, { reportToIds: { has: id } }] },
    select: { id: true, assigneeIds: true, reportToIds: true },
  });

  await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { userId: id } }),
    prisma.refreshToken.deleteMany({ where: { userId: id } }),
    prisma.notification.deleteMany({ where: { toUserId: id } }),
    // Anyone reporting to this person now reports to nobody.
    prisma.user.updateMany({ where: { reportsToId: id }, data: { reportsToId: null } }),
    ...tasks.map((task) => {
      const assigneeIds = task.assigneeIds.filter((x) => x !== id);
      return prisma.task.update({
        where: { id: task.id },
        data: {
          assigneeIds,
          assigneeId: assigneeIds[0] ?? null,
          reportToIds: task.reportToIds.filter((x) => x !== id),
        },
      });
    }),
    prisma.user.delete({ where: { id } }),
  ]);

  logger.warn({ userId: id, by: auth.userId }, "employee deleted");
}

/* -------------------------------------------------------- resend invite -- */

export async function resendEmployeeInvite(auth: UserAuth, id: string) {
  const target = await assertCanWrite(auth, id);
  if (target.state === "active") throw ApiError.conflict("This person has already set a password.");

  const company = await prisma.company.findUnique({
    where: { id: auth.companyId },
    select: { companyName: true },
  });

  const invite = issueToken(INVITE_TTL_MS);
  await prisma.user.update({
    where: { id },
    data: { inviteTokenHash: invite.tokenHash, inviteExpiresAt: invite.expiresAt, state: "invited" },
  });

  const url = inviteUrl(invite.token);
  const { queued } = queueMail(
    employeeInviteMail({
      to: target.email,
      name: target.name,
      companyName: company?.companyName ?? "Jadvix",
      url,
    }),
  );

  return { queued, expiresAt: invite.expiresAt, ...(env.mailEnabled ? {} : { url }) };
}
