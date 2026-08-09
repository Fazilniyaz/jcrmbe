import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { hashPassword, verifyPassword } from "../../lib/password";
import {
  MODULE_SLUGS,
  defaultModulesForRole,
  effectiveModules,
  type ModuleSlug,
} from "../../lib/modules";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import { revokeAllSessions } from "../auth/auth.service";
import { resolveScope } from "../branches/branches.service";
import { ALL_BRANCHES } from "../branches/branches.schema";
import type {
  ChangePasswordInput,
  SetModuleAccessInput,
  UpdateProfileInput,
  WorkspaceInput,
} from "./settings.schema";

/*
 * Settings — the one module every portal has.
 *
 * Three things live here: your own profile, your own password, and (for a
 * superAdmin) who may open which module. The first two are always about the
 * caller and never take a user id, which is the simplest possible defence
 * against changing someone else's.
 */

/* -------------------------------------------------------------- profile -- */

export async function getProfile(auth: UserAuth) {
  const user = await prisma.user.findFirst({
    where: { id: auth.userId, companyId: auth.companyId },
    select: {
      id: true,
      name: true,
      email: true,
      empId: true,
      phone: true,
      tone: true,
      roles: true,
      empType: true,
      empStatus: true,
      currentStatus: true,
      kra: true,
      openWork: true,
      isOwner: true,
      joinedAt: true,
      lastLoginAt: true,
      moduleAccess: true,
      branch: { select: { id: true, name: true } },
      reportsTo: { select: { id: true, name: true, empId: true } },
      company: { select: { id: true, companyName: true, headBranch: true, settings: true } },
    },
  });
  if (!user) throw ApiError.notFound("Profile not found.");

  return {
    ...user,
    branch: user.branch?.name ?? null,
    modules: effectiveModules(user.roles, user.moduleAccess),
    defaultModules: defaultModulesForRole(user.roles),
  };
}

/** Name, phone and avatar colour. Email, roles and empId are not self-service. */
export async function updateProfile(auth: UserAuth, input: UpdateProfileInput) {
  await prisma.user.update({
    where: { id: auth.userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
    },
  });
  return getProfile(auth);
}

/* ------------------------------------------------------------- password -- */

/**
 * Change your own password.
 *
 * The current password is verified first — an access token is not enough,
 * because a stolen token should not be usable to lock the real owner out. Every
 * other session is then revoked, so a change also evicts whoever the theft was.
 */
export async function changePassword(auth: UserAuth, input: ChangePasswordInput) {
  const user = await prisma.user.findFirst({
    where: { id: auth.userId, companyId: auth.companyId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw ApiError.unauthorized();

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    logger.warn({ userId: auth.userId }, "failed password change: wrong current password");
    throw ApiError.badRequest("Your current password isn't right.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      resetTokenHash: null,
      resetExpiresAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  await revokeAllSessions(user.id);
  logger.info({ userId: user.id }, "password changed — all sessions revoked");

  return { message: "Password updated. Other devices have been signed out." };
}

/* -------------------------------------------------------- module access -- */

export function moduleRegistry(auth: UserAuth) {
  return {
    modules: MODULE_SLUGS,
    mine: effectiveModules(auth.roles, auth.moduleAccess),
    defaults: defaultModulesForRole(auth.roles),
    grants: auth.moduleAccess,
  };
}

/** The access matrix a superAdmin edits: every user, their defaults and grants. */
export async function listModuleAccess(auth: UserAuth) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can manage module access.");

  const users = await prisma.user.findMany({
    where: { companyId: auth.companyId, state: { not: "disabled" } },
    select: {
      id: true,
      name: true,
      empId: true,
      email: true,
      roles: true,
      empType: true,
      isOwner: true,
      moduleAccess: true,
    },
    orderBy: { name: "asc" },
  });

  return {
    modules: MODULE_SLUGS,
    rows: users.map((user) => ({
      ...user,
      defaults: defaultModulesForRole(user.roles),
      granted: user.moduleAccess,
      effective: effectiveModules(user.roles, user.moduleAccess),
      // A superAdmin's grid row is read-only: they already have everything and
      // reducing it would be a way to lock the owner out of their own company.
      locked: user.roles.includes("superAdmin") || user.isOwner,
    })),
  };
}

/**
 * Grant or revoke extra modules for one user.
 *
 * Only the EXTRAS are stored. Role defaults are computed, never written, so a
 * role change automatically brings the right baseline with it instead of
 * leaving a stale grant behind.
 */
export async function setModuleAccess(auth: UserAuth, userId: string, input: SetModuleAccessInput) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can manage module access.");

  const target = await prisma.user.findFirst({
    where: { id: userId, companyId: auth.companyId },
    select: { id: true, roles: true, isOwner: true },
  });
  if (!target) throw ApiError.notFound("No such employee.");
  if (target.roles.includes("superAdmin") || target.isOwner) {
    throw ApiError.badRequest("A super admin already has every module.");
  }

  const defaults = new Set<ModuleSlug>(defaultModulesForRole(target.roles));
  // Anything already covered by the role is dropped: storing it would be a
  // grant that silently survives a demotion.
  const extras = [...new Set(input.modules)].filter((slug) => !defaults.has(slug));

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { moduleAccess: extras },
    select: { id: true, name: true, roles: true, moduleAccess: true },
  });

  logger.info({ userId, by: auth.userId, grants: extras }, "module access updated");

  return {
    ...updated,
    defaults: defaultModulesForRole(updated.roles),
    granted: updated.moduleAccess,
    effective: effectiveModules(updated.roles, updated.moduleAccess),
  };
}

/* ------------------------------------------------------------ workspace -- */

export async function getWorkspace(auth: UserAuth) {
  const company = await prisma.company.findUnique({
    where: { id: auth.companyId },
    select: { id: true, companyName: true, headBranch: true, settings: true, state: true },
  });
  if (!company) throw ApiError.notFound("Company not found.");

  const [branches, scope] = await Promise.all([
    prisma.branch.findMany({
      where: { companyId: auth.companyId },
      select: { id: true, name: true, isHead: true },
      orderBy: [{ isHead: "desc" }, { name: "asc" }],
    }),
    resolveScope(auth.companyId),
  ]);

  return {
    company: { id: company.id, name: company.companyName, headBranch: company.headBranch },
    settings: {
      autoEmployeeId: company.settings?.autoEmployeeId ?? true,
      // The EFFECTIVE branch, not the raw column. A stored null means "nobody
      // has chosen", which resolves to the head office — so every consumer sees
      // the branch that is actually in force rather than having to re-derive it.
      defaultBranch: scope.effective,
      defaultBranchExplicit: scope.explicit,
      headBranch: scope.headBranch,
      allBranches: scope.effective === null,
      // The currency figures should be shown in, from the branch in force.
      currency: scope.currency,
      currencySymbol: scope.currencySymbol,
    },
    branches,
  };
}

/** Workspace-wide preferences — the pinned branch affects everyone's numbers. */
export async function updateWorkspace(auth: UserAuth, input: WorkspaceInput) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can change workspace settings.");

  const current = await prisma.company.findUnique({
    where: { id: auth.companyId },
    select: { settings: true },
  });

  const settings = {
    autoEmployeeId: input.autoEmployeeId ?? current?.settings?.autoEmployeeId ?? true,
    defaultBranch:
      input.defaultBranch !== undefined
        ? (input.defaultBranch || null)
        : (current?.settings?.defaultBranch ?? null),
  };

  // `null` (back to the head office) and the all-branches sentinel are both
  // legal and name no branch; anything else has to exist, or the scope would be
  // a string pointing at nothing and every module would silently empty.
  if (settings.defaultBranch && settings.defaultBranch !== ALL_BRANCHES) {
    const branch = await prisma.branch.findFirst({
      where: { companyId: auth.companyId, name: settings.defaultBranch },
      select: { id: true },
    });
    if (!branch) throw ApiError.badRequest("No such branch in this company.");
  }

  await prisma.company.update({ where: { id: auth.companyId }, data: { settings } });
  return getWorkspace(auth);
}
