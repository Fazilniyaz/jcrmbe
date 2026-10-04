import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isLead, type UserAuth } from "../../middleware/auth";
import type { CreateTeamInput, UpdateTeamInput } from "./teams.schema";

/*
 * Teams.
 *
 * Deliberately small: a name, a colour, an optional lead and a list of people.
 * The interesting behaviour is not here — it is at the point of ASSIGNMENT, in
 * the project and task services, which expand a team into real memberships and
 * assignees. See the note on the Team model.
 */

const TEAM_SELECT = {
  id: true,
  name: true,
  description: true,
  tone: true,
  leadId: true,
  memberIds: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<string, true>;

/** Writing to the org chart is a lead's job, not every employee's. */
function assertCanManage(auth: UserAuth) {
  if (!isLead(auth)) throw ApiError.forbidden("Only a manager or super admin can change teams.");
}

/**
 * Validate the people, and the lead.
 *
 * Every id must be a live user in the CALLER's company — that is what stops a
 * team being used to name someone in another tenant — and the lead, when given,
 * must be one of the members. A lead who is not on their own team is the kind
 * of state that quietly breaks a picker later.
 */
async function resolveMembers(companyId: string, ids: readonly string[], leadId?: string | null) {
  const unique = [...new Set(ids)];

  const users = unique.length
    ? await prisma.user.findMany({
        where: { id: { in: unique }, companyId, state: { not: "disabled" } },
        select: { id: true },
      })
    : [];

  if (users.length !== unique.length) {
    throw ApiError.badRequest("One of those people is not in this workspace.");
  }
  if (leadId && !unique.includes(leadId)) {
    throw ApiError.badRequest("The team lead has to be a member of the team.");
  }
  return unique;
}

/** Teams, each with its people resolved so a picker needs one request. */
export async function listTeams(auth: UserAuth) {
  const teams = await prisma.team.findMany({
    where: { companyId: auth.companyId },
    select: TEAM_SELECT,
    orderBy: { name: "asc" },
  });

  // One lookup for every person on every team, then joined in memory — a
  // query per team would scale with the org chart.
  const ids = [...new Set(teams.flatMap((t) => t.memberIds))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, companyId: auth.companyId },
        select: { id: true, name: true, empId: true, email: true, tone: true, roles: true, kra: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  return teams.map((team) => ({
    ...team,
    members: team.memberIds.map((id) => byId.get(id)).filter((u) => u !== undefined),
  }));
}

export async function createTeam(auth: UserAuth, input: CreateTeamInput) {
  assertCanManage(auth);

  const memberIds = await resolveMembers(auth.companyId, input.memberIds, input.leadId);

  const existing = await prisma.team.findFirst({
    where: { companyId: auth.companyId, name: input.name },
    select: { id: true },
  });
  if (existing) throw ApiError.badRequest("A team with that name already exists.");

  const team = await prisma.team.create({
    data: {
      companyId: auth.companyId,
      name: input.name,
      description: input.description ?? null,
      tone: input.tone || "blue",
      leadId: input.leadId ?? null,
      memberIds,
      createdById: auth.userId,
    },
    select: TEAM_SELECT,
  });

  logger.info({ teamId: team.id, by: auth.userId }, "team created");
  return team;
}

export async function updateTeam(auth: UserAuth, teamId: string, input: UpdateTeamInput) {
  assertCanManage(auth);

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: auth.companyId },
    select: { id: true, memberIds: true, leadId: true },
  });
  if (!team) throw ApiError.notFound("No such team.");

  // The lead has to be checked against the members the team will HAVE, not the
  // ones it had — otherwise swapping both in one call rejects a valid pair.
  const nextMembers = input.memberIds ?? team.memberIds;
  const nextLead = input.leadId === undefined ? team.leadId : input.leadId;
  const memberIds = await resolveMembers(auth.companyId, nextMembers, nextLead);

  if (input.name) {
    const clash = await prisma.team.findFirst({
      where: { companyId: auth.companyId, name: input.name, id: { not: teamId } },
      select: { id: true },
    });
    if (clash) throw ApiError.badRequest("A team with that name already exists.");
  }

  const updated = await prisma.team.update({
    where: { id: teamId },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.leadId !== undefined ? { leadId: input.leadId ?? null } : {}),
      ...(input.memberIds !== undefined ? { memberIds } : {}),
    },
    select: TEAM_SELECT,
  });

  logger.info({ teamId, by: auth.userId }, "team updated");
  return updated;
}

/**
 * Delete a team, and unpick it from whatever referenced it.
 *
 * The PEOPLE it put on projects and tasks stay exactly where they are — they
 * were placed individually and may have work assigned. Only the reference goes,
 * so nothing is left pointing at a team that no longer exists.
 */
export async function deleteTeam(auth: UserAuth, teamId: string) {
  assertCanManage(auth);

  const team = await prisma.team.findFirst({
    where: { id: teamId, companyId: auth.companyId },
    select: { id: true, name: true },
  });
  if (!team) throw ApiError.notFound("No such team.");

  const [projects, tasks] = await Promise.all([
    prisma.project.findMany({
      where: { companyId: auth.companyId, teamIds: { has: teamId } },
      select: { id: true, teamIds: true },
    }),
    prisma.task.findMany({
      where: { companyId: auth.companyId, teamIds: { has: teamId } },
      select: { id: true, teamIds: true },
    }),
  ]);

  await prisma.$transaction([
    ...projects.map((p) =>
      prisma.project.update({
        where: { id: p.id },
        data: { teamIds: p.teamIds.filter((id) => id !== teamId) },
      }),
    ),
    ...tasks.map((t) =>
      prisma.task.update({
        where: { id: t.id },
        data: { teamIds: t.teamIds.filter((id) => id !== teamId) },
      }),
    ),
    prisma.team.delete({ where: { id: teamId } }),
  ]);

  logger.info(
    { teamId, by: auth.userId, projects: projects.length, tasks: tasks.length },
    "team deleted",
  );
  return { id: teamId, detachedFrom: { projects: projects.length, tasks: tasks.length } };
}

/**
 * The people on a set of teams, as one flat list of ids.
 *
 * This is what "assign a team" actually means everywhere else: the project and
 * task services call it and merge the result into their own member/assignee
 * lists, so a team never becomes a second source of truth for who is on what.
 */
export async function membersOfTeams(companyId: string, teamIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return [];

  const teams = await prisma.team.findMany({
    where: { id: { in: unique }, companyId },
    select: { id: true, memberIds: true },
  });

  if (teams.length !== unique.length) {
    throw ApiError.badRequest("One of those teams does not exist in this workspace.");
  }
  return [...new Set(teams.flatMap((t) => t.memberIds))];
}
