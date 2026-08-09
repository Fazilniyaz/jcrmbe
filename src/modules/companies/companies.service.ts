import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { withEmpId } from "../../lib/empId";
import { INVITE_TTL_MS, issueToken } from "../../lib/tokens";
import { ownerInviteMail, queueMail } from "../../lib/mailer";
import { currencyFor, getCountry } from "../../lib/countries";
import type { CreateCompanyInput, ListCompaniesQuery, UpdateCompanyInput } from "./companies.schema";

/*
 * Companies — the master portal's only data module.
 *
 * Creating one is three writes that have to agree: the company, its head
 * branch, and the owner user who will be its superAdmin. They are done in a
 * transaction so a half-created tenant (a company nobody can sign into) is not
 * a state the system can reach.
 */

const COMPANY_SELECT = {
  id: true,
  companyName: true,
  companyAddress: true,
  linkedinProfile: true,
  companyWebsite: true,
  about: true,
  ownerName: true,
  email: true,
  headBranch: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  /*
   * The head office's location, flattened onto the company.
   *
   * `headBranch` is a name on Company but the city, country and currency live
   * on the Branch row. Carrying them here means the Companies screen can render
   * and edit a company in one request instead of fetching its branches to fill
   * in three fields.
   */
  branches: {
    where: { isHead: true },
    select: { city: true, country: true, currency: true },
    take: 1,
  },
} satisfies Prisma.CompanySelect;

type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof COMPANY_SELECT }>;

function shapeCompany<T extends CompanyRow>(row: T) {
  const { branches, ...company } = row;
  const head = branches[0];
  const country = getCountry(head?.country);
  return {
    ...company,
    headBranchCity: head?.city ?? null,
    headBranchCountry: head?.country ?? null,
    headBranchCurrency: head?.currency ?? null,
    headBranchCountryName: country?.name ?? null,
    headBranchCurrencySymbol: country?.symbol ?? null,
  };
}

/** Owner-facing summary of the invite, without ever exposing the token hash. */
async function ownerSummary(companyId: string) {
  const owner = await prisma.user.findFirst({
    where: { companyId, isOwner: true },
    select: {
      id: true,
      name: true,
      email: true,
      empId: true,
      state: true,
      inviteExpiresAt: true,
      inviteTokenHash: true,
      lastLoginAt: true,
    },
  });
  if (!owner) return null;

  const { inviteTokenHash, ...rest } = owner;
  return {
    ...rest,
    invitePending: Boolean(inviteTokenHash),
    inviteExpired: Boolean(
      inviteTokenHash && owner.inviteExpiresAt && owner.inviteExpiresAt <= new Date(),
    ),
  };
}

export async function listCompanies(query: ListCompaniesQuery) {
  const where: Prisma.CompanyWhereInput = {
    ...(query.state ? { state: query.state } : {}),
    ...(query.q
      ? {
          OR: [
            { companyName: { contains: query.q, mode: "insensitive" } },
            { ownerName: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.company.findMany({
      where,
      select: { ...COMPANY_SELECT, _count: { select: { users: true, projects: true } } },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
    prisma.company.count({ where }),
  ]);

  return {
    rows: rows.map(({ _count, ...company }) => ({
      ...shapeCompany(company),
      userCount: _count.users,
      projectCount: _count.projects,
    })),
    total,
  };
}

export async function getCompany(id: string) {
  const company = await prisma.company.findUnique({
    where: { id },
    select: {
      ...COMPANY_SELECT,
      branches: {
        select: { id: true, name: true, isHead: true, city: true, country: true, currency: true },
        orderBy: [{ isHead: "desc" }, { name: "asc" }],
      },
      _count: { select: { users: true, projects: true, tasks: true } },
    },
  });
  if (!company) throw ApiError.notFound("No such company.");

  const { _count, branches, ...rest } = company;
  return {
    ...shapeCompany({ ...rest, branches: branches.filter((b) => b.isHead) }),
    // The full branch list, not just the head office.
    branches,
    userCount: _count.users,
    projectCount: _count.projects,
    taskCount: _count.tasks,
    owner: await ownerSummary(id),
  };
}

/* ---------------------------------------------------------------- create -- */

export async function createCompany(input: CreateCompanyInput) {
  const existing = await prisma.company.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw ApiError.conflict("A company already uses that email address.");

  const invite = issueToken(INVITE_TTL_MS);

  const company = await withEmpId(undefined, (empId) =>
    prisma.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          companyName: input.companyName,
          companyAddress: input.companyAddress,
          linkedinProfile: input.linkedinProfile ?? null,
          companyWebsite: input.companyWebsite,
          about: input.about,
          ownerName: input.ownerName,
          email: input.email,
          headBranch: input.headBranch,
          state: "invited",
          settings: { autoEmployeeId: true, defaultBranch: null },
        },
        select: COMPANY_SELECT,
      });

      const branch = await tx.branch.create({
        data: {
          companyId: created.id,
          name: input.headBranch,
          isHead: true,
          city: input.headBranchCity,
          country: input.headBranchCountry,
          // Looked up, never taken from the request. See lib/countries.ts.
          currency: currencyFor(input.headBranchCountry),
        },
        select: { id: true },
      });

      await tx.user.create({
        data: {
          companyId: created.id,
          name: input.ownerName,
          email: input.email,
          empId,
          roles: ["superAdmin"],
          empType: "admin",
          isOwner: true,
          state: "invited",
          branchId: branch.id,
          // No passwordHash yet — the invite is what sets it.
          inviteTokenHash: invite.tokenHash,
          inviteExpiresAt: invite.expiresAt,
        },
        select: { id: true },
      });

      return created;
    }),
  );

  // Queued after the transaction commits: an email about a company that was
  // rolled back would be worse than a company whose email needs re-sending.
  // Queued rather than awaited so SMTP latency is not on the response path.
  const url = inviteUrl(invite.token);
  const { queued } = queueMail(
    ownerInviteMail({
      to: input.email,
      ownerName: input.ownerName,
      companyName: input.companyName,
      url,
    }),
  );

  logger.info({ companyId: company.id, mailQueued: queued }, "company created");

  return {
    // Re-read rather than shaped from `company`: the head branch is created
    // inside the transaction AFTER the company row, so the relation on that
    // result is empty and the location fields would come back null.
    company: shapeCompany(
      await prisma.company.findUniqueOrThrow({ where: { id: company.id }, select: COMPANY_SELECT }),
    ),
    invite: {
      queued,
      expiresAt: invite.expiresAt,
      // Returned ONLY when mail is not configured, so local development can
      // still complete the flow. With SMTP working the token never leaves the
      // server — see the guard.
      ...(env.mailEnabled ? {} : { url }),
    },
  };
}

export function inviteUrl(token: string): string {
  const base = env.APP_URL.replace(/\/$/, "");
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}

/* ---------------------------------------------------------------- update -- */

export async function updateCompany(id: string, input: UpdateCompanyInput) {
  const existing = await prisma.company.findUnique({ where: { id }, select: { id: true, state: true } });
  if (!existing) throw ApiError.notFound("No such company.");

  const data: Prisma.CompanyUpdateInput = {
    ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
    ...(input.companyAddress !== undefined ? { companyAddress: input.companyAddress } : {}),
    ...(input.linkedinProfile !== undefined ? { linkedinProfile: input.linkedinProfile ?? null } : {}),
    ...(input.companyWebsite !== undefined ? { companyWebsite: input.companyWebsite } : {}),
    ...(input.about !== undefined ? { about: input.about } : {}),
    ...(input.ownerName !== undefined ? { ownerName: input.ownerName } : {}),
    ...(input.headBranch !== undefined ? { headBranch: input.headBranch } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
  };

  // Not read: the head-office edits below can change the response, so it is
  // re-read at the end rather than shaped from this result.
  await prisma.company.update({ where: { id }, data, select: { id: true } });

  /*
   * The head office is a Branch row as well as a name on the Company, so an
   * edit here has to reach both. Without this the Companies screen would show
   * the new city while the Branches module still showed the old one, and the
   * currency would keep following a country nobody had selected any more.
   */
  const headEdits =
    input.headBranch !== undefined ||
    input.headBranchCity !== undefined ||
    input.headBranchCountry !== undefined;

  if (headEdits) {
    await prisma.branch.updateMany({
      where: { companyId: id, isHead: true },
      data: {
        ...(input.headBranch !== undefined ? { name: input.headBranch } : {}),
        ...(input.headBranchCity !== undefined ? { city: input.headBranchCity } : {}),
        ...(input.headBranchCountry !== undefined
          ? {
              country: input.headBranchCountry,
              currency: currencyFor(input.headBranchCountry),
            }
          : {}),
      },
    });
  }

  // Disabling a tenant has to end its sessions, or everyone stays signed in
  // until their refresh token happens to expire.
  if (input.state === "disabled" && existing.state !== "disabled") {
    const users = await prisma.user.findMany({ where: { companyId: id }, select: { id: true } });
    await prisma.refreshToken.updateMany({
      where: { userId: { in: users.map((u) => u.id) }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ companyId: id }, "company disabled — all sessions revoked");
  }

  // Re-read so the head-office edits above are reflected in the response.
  return shapeCompany(
    await prisma.company.findUniqueOrThrow({ where: { id }, select: COMPANY_SELECT }),
  );
}

/* --------------------------------------------------------------- delete -- */

/**
 * Deletes the tenant and everything in it.
 *
 * Mongo has no cascading deletes, so every collection is cleared explicitly and
 * in dependency order. Irreversible, master-only, and the reason the route asks
 * for the company name as confirmation.
 */
export async function deleteCompany(id: string) {
  const company = await prisma.company.findUnique({ where: { id }, select: { id: true, companyName: true } });
  if (!company) throw ApiError.notFound("No such company.");

  const users = await prisma.user.findMany({ where: { companyId: id }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const projects = await prisma.project.findMany({ where: { companyId: id }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);

  await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.notification.deleteMany({ where: { companyId: id } }),
    prisma.kraEvent.deleteMany({ where: { companyId: id } }),
    prisma.task.deleteMany({ where: { companyId: id } }),
    prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.project.deleteMany({ where: { companyId: id } }),
    prisma.user.deleteMany({ where: { companyId: id } }),
    prisma.branch.deleteMany({ where: { companyId: id } }),
    prisma.company.delete({ where: { id } }),
  ]);

  logger.warn({ companyId: id, companyName: company.companyName }, "company deleted");
}

/* --------------------------------------------------------- resend invite -- */

export async function resendOwnerInvite(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, companyName: true, ownerName: true, email: true },
  });
  if (!company) throw ApiError.notFound("No such company.");

  const owner = await prisma.user.findFirst({
    where: { companyId, isOwner: true },
    select: { id: true, name: true, email: true, state: true },
  });
  if (!owner) throw ApiError.notFound("This company has no owner account.");
  if (owner.state === "active") {
    throw ApiError.conflict("The owner has already set a password.");
  }

  const invite = issueToken(INVITE_TTL_MS);
  await prisma.user.update({
    where: { id: owner.id },
    data: { inviteTokenHash: invite.tokenHash, inviteExpiresAt: invite.expiresAt, state: "invited" },
  });

  const url = inviteUrl(invite.token);
  const { queued } = queueMail(
    ownerInviteMail({
      to: owner.email,
      ownerName: owner.name,
      companyName: company.companyName,
      url,
    }),
  );

  logger.info({ companyId, mailQueued: queued }, "owner invite re-sent");
  return { queued, expiresAt: invite.expiresAt, ...(env.mailEnabled ? {} : { url }) };
}

/* ------------------------------------------------------------ dashboard -- */

/** The master dashboard's numbers. One query per tile, all counts. */
export async function masterDashboard() {
  const [total, active, invited, disabled, recent, userCount, projectCount] = await Promise.all([
    prisma.company.count(),
    prisma.company.count({ where: { state: "active" } }),
    prisma.company.count({ where: { state: "invited" } }),
    prisma.company.count({ where: { state: "disabled" } }),
    prisma.company.findMany({
      select: { ...COMPANY_SELECT, _count: { select: { users: true } } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.user.count(),
    prisma.project.count(),
  ]);

  const pendingInvites = await prisma.user.findMany({
    where: { isOwner: true, state: "invited", inviteTokenHash: { not: null } },
    select: {
      id: true,
      name: true,
      email: true,
      inviteExpiresAt: true,
      company: { select: { id: true, companyName: true, createdAt: true } },
    },
    orderBy: { joinedAt: "desc" },
    take: 8,
  });

  const now = new Date();

  return {
    counts: { total, active, invited, disabled, users: userCount, projects: projectCount },
    recent: recent.map(({ _count, ...c }) => ({ ...shapeCompany(c), userCount: _count.users })),
    pendingInvites: pendingInvites.map((i) => ({
      userId: i.id,
      name: i.name,
      email: i.email,
      companyId: i.company.id,
      companyName: i.company.companyName,
      invitedAt: i.company.createdAt,
      expiresAt: i.inviteExpiresAt,
      expired: Boolean(i.inviteExpiresAt && i.inviteExpiresAt <= now),
    })),
  };
}
