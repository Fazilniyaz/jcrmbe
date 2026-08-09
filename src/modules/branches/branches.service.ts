import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isSuperAdmin, type UserAuth } from "../../middleware/auth";
import { currencyFor, getCountry } from "../../lib/countries";
import {
  ALL_BRANCHES,
  type CreateBranchInput,
  type SetDefaultBranchInput,
  type UpdateBranchInput,
} from "./branches.schema";

/*
 * Branches, and the default-branch scope.
 *
 * A company gets exactly one branch when it is created — `headBranch`, from the
 * Create Company form — and it is marked `isHead`. That branch is the standing
 * default: until somebody explicitly pins another, every module is scoped to it.
 * With one branch that is indistinguishable from showing everything, which is
 * why it costs nothing at the start and starts mattering the moment a second
 * office exists.
 *
 * Three states, one nullable column:
 *
 *   settings.defaultBranch = null   -> the head branch (nobody has chosen)
 *   settings.defaultBranch = "Kochi"-> that branch
 *   settings.defaultBranch = "*"    -> no scope, the whole group
 */

export type ResolvedScope = {
  /** The branch name every module filters by, or null for the whole group. */
  effective: string | null;
  /** True when the value came from an explicit choice rather than the head. */
  explicit: boolean;
  headBranch: string | null;
  /**
   * The currency of the branch in force — what money should be formatted in.
   *
   * Null when the scope is "all branches", because a group spanning three
   * currencies has no single one to report in, and picking the head office's
   * would silently mis-state the other two.
   */
  currency: string | null;
  currencySymbol: string | null;
};

/** The single place the three states above are turned into one answer. */
export async function resolveScope(companyId: string): Promise<ResolvedScope> {
  const [company, branches] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } }),
    prisma.branch.findMany({
      where: { companyId },
      select: { name: true, isHead: true, country: true, currency: true },
    }),
  ]);

  const stored = company?.settings?.defaultBranch ?? null;
  const head = branches.find((b) => b.isHead) ?? null;
  const headBranch = head?.name ?? null;

  const effective =
    stored === ALL_BRANCHES ? null : (stored ?? headBranch);
  const explicit = stored !== null;

  const inForce = effective ? (branches.find((b) => b.name === effective) ?? null) : null;
  const country = getCountry(inForce?.country);

  return {
    effective,
    explicit,
    headBranch,
    currency: inForce?.currency ?? null,
    currencySymbol: country?.symbol ?? null,
  };
}

/**
 * The branch a new employee lands in when the form didn't name one.
 *
 * The one the workspace is currently scoped to — an admin adding someone while
 * working in a pinned hub means that hub. Falls back to the head office when
 * the scope is "all branches", since a null branch would hide the new joiner
 * from every scoped view.
 */
export async function scopedBranchId(companyId: string): Promise<string | null> {
  const scope = await resolveScope(companyId);
  const name = scope.effective ?? scope.headBranch;
  if (!name) return null;

  const branch = await prisma.branch.findFirst({
    where: { companyId, name },
    select: { id: true },
  });
  return branch?.id ?? null;
}

/* ------------------------------------------------------------------ list -- */

/**
 * Every branch, with the headcount and project count the cards show.
 *
 * The numbers are derived from the roster rather than stored, so they agree
 * with what Employees and Projects display once a branch is pinned — a stored
 * headcount would drift the first time someone moved office.
 */
export async function listBranches(auth: UserAuth) {
  const [branches, employees, scope] = await Promise.all([
    prisma.branch.findMany({
      where: { companyId: auth.companyId },
      select: {
        id: true,
        name: true,
        isHead: true,
        createdAt: true,
        city: true,
        country: true,
        currency: true,
      },
      orderBy: [{ isHead: "desc" }, { name: "asc" }],
    }),
    prisma.user.findMany({
      where: { companyId: auth.companyId, state: { not: "disabled" } },
      select: { id: true, branchId: true, roles: true, name: true, empId: true, tone: true },
    }),
    resolveScope(auth.companyId),
  ]);

  const memberships = await prisma.projectMember.findMany({
    where: { state: "accepted", project: { companyId: auth.companyId } },
    select: { projectId: true, userId: true },
  });

  const rows = branches.map((branch) => {
    const people = employees.filter((e) => e.branchId === branch.id);
    const ids = new Set(people.map((e) => e.id));

    // A project belongs to a branch if anyone accepted onto it works there —
    // the same rule the frontend's scopedProjects already applies.
    const projects = new Set(
      memberships.filter((m) => ids.has(m.userId)).map((m) => m.projectId),
    );

    // Whoever leads the office, for the card's avatar. Managers first.
    const lead =
      people.find((p) => p.roles.includes("superAdmin")) ??
      people.find((p) => p.roles.includes("manager")) ??
      people.find((p) => p.roles.includes("teamLeader")) ??
      null;

    const country = getCountry(branch.country);

    return {
      id: branch.id,
      name: branch.name,
      isHead: branch.isHead,
      createdAt: branch.createdAt,
      city: branch.city,
      country: branch.country,
      countryName: country?.name ?? null,
      currency: branch.currency,
      currencySymbol: country?.symbol ?? null,
      headcount: people.length,
      projectCount: projects.size,
      lead: lead ? { id: lead.id, name: lead.name, empId: lead.empId, tone: lead.tone } : null,
      isDefault: scope.effective === branch.name,
    };
  });

  // People whose branch was never set would vanish from every module the moment
  // a scope applied, so the count is surfaced rather than left to be discovered.
  const unassigned = employees.filter((e) => !e.branchId).length;

  return {
    branches: rows,
    scope: {
      defaultBranch: scope.effective,
      explicit: scope.explicit,
      headBranch: scope.headBranch,
      allBranches: scope.effective === null,
    },
    groupHeadcount: employees.length,
    unassigned,
  };
}

/* ---------------------------------------------------------------- create -- */

export async function createBranch(auth: UserAuth, input: CreateBranchInput) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can add a branch.");

  const clash = await prisma.branch.findFirst({
    where: { companyId: auth.companyId, name: { equals: input.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (clash) throw ApiError.conflict("This company already has a branch with that name.");

  const branch = await prisma.branch.create({
    // Never `isHead` — a company has exactly one head office, set when it was
    // created, and moving it is not something this endpoint decides.
    data: {
      companyId: auth.companyId,
      name: input.name,
      isHead: false,
      city: input.city,
      country: input.country,
      currency: currencyFor(input.country),
    },
    select: { id: true, name: true, isHead: true, city: true, country: true, currency: true },
  });

  if (input.setDefault) {
    await writeDefault(auth.companyId, branch.name);
  }

  logger.info({ branchId: branch.id, companyId: auth.companyId, by: auth.userId }, "branch created");
  return branch;
}

/* ---------------------------------------------------------------- update -- */

export async function updateBranch(auth: UserAuth, id: string, input: UpdateBranchInput) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can change a branch.");

  const branch = await prisma.branch.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true, name: true, isHead: true },
  });
  if (!branch) throw ApiError.notFound("No such branch.");

  if (input.name && input.name.toLowerCase() !== branch.name.toLowerCase()) {
    const clash = await prisma.branch.findFirst({
      where: {
        companyId: auth.companyId,
        name: { equals: input.name, mode: "insensitive" },
        id: { not: id },
      },
      select: { id: true },
    });
    if (clash) throw ApiError.conflict("This company already has a branch with that name.");
  }

  const updated = await prisma.branch.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      // Country and currency move together, always. Changing the country and
      // leaving the old currency behind is the exact corruption the derived
      // lookup exists to prevent.
      ...(input.country !== undefined
        ? { country: input.country, currency: currencyFor(input.country) }
        : {}),
    },
    select: { id: true, name: true, isHead: true, city: true, country: true, currency: true },
  });

  if (input.name && input.name !== branch.name) {
    // The scope is stored by NAME, so a rename has to carry it — otherwise
    // pinning survives as a string pointing at a branch that no longer exists
    // and every module silently empties.
    const scope = await resolveScope(auth.companyId);
    if (scope.explicit && scope.effective === branch.name) {
      await writeDefault(auth.companyId, input.name);
    }
    if (branch.isHead) {
      await prisma.company.update({
        where: { id: auth.companyId },
        data: { headBranch: input.name },
      });
    }
  }

  return updated;
}

/* ---------------------------------------------------------------- delete -- */

export async function deleteBranch(auth: UserAuth, id: string) {
  if (!isSuperAdmin(auth)) throw ApiError.forbidden("Only a super admin can remove a branch.");

  const branch = await prisma.branch.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true, name: true, isHead: true },
  });
  if (!branch) throw ApiError.notFound("No such branch.");
  if (branch.isHead) {
    throw ApiError.badRequest("The head office can't be removed. Rename it instead.");
  }

  const occupants = await prisma.user.count({ where: { companyId: auth.companyId, branchId: id } });
  if (occupants > 0) {
    throw ApiError.conflict(
      `${occupants} ${occupants === 1 ? "person is" : "people are"} still in this branch. Move them first.`,
      { occupants },
    );
  }

  const scope = await resolveScope(auth.companyId);
  await prisma.branch.delete({ where: { id } });

  // Deleting what was pinned falls back to the head branch rather than leaving
  // a dangling name behind.
  if (scope.explicit && scope.effective === branch.name) {
    await writeDefault(auth.companyId, null);
  }

  logger.warn({ branchId: id, companyId: auth.companyId, by: auth.userId }, "branch deleted");
}

/* --------------------------------------------------------------- default -- */

async function writeDefault(companyId: string, value: string | null) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settings: true },
  });

  await prisma.company.update({
    where: { id: companyId },
    data: {
      settings: {
        autoEmployeeId: company?.settings?.autoEmployeeId ?? true,
        defaultBranch: value,
      },
    },
  });
}

export async function setDefaultBranch(auth: UserAuth, input: SetDefaultBranchInput) {
  if (!isSuperAdmin(auth)) {
    throw ApiError.forbidden("Only a super admin can change the workspace's default branch.");
  }

  if (input.all) {
    await writeDefault(auth.companyId, ALL_BRANCHES);
  } else if (input.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: input.branchId, companyId: auth.companyId },
      select: { name: true },
    });
    if (!branch) throw ApiError.badRequest("No such branch.");
    await writeDefault(auth.companyId, branch.name);
  } else {
    // null — back to the head branch.
    await writeDefault(auth.companyId, null);
  }

  const scope = await resolveScope(auth.companyId);
  logger.info(
    { companyId: auth.companyId, by: auth.userId, scope: scope.effective ?? "all branches" },
    "default branch changed",
  );
  return scope;
}
