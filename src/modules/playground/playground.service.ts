import { prisma } from "../../lib/prisma";
import type { UserAuth } from "../../middleware/auth";

/*
 * The roster behind "Your Playground".
 *
 * One screen that answers "who is in this office, how are they doing, and what
 * are they on" — so it is assembled here in four flat queries and composed in
 * memory, rather than letting the client fan out one request per person. With
 * a hundred employees the N+1 version would be a hundred round trips to draw
 * one grid.
 *
 * Everything is scoped to the caller's own company by `companyId`, which comes
 * from the verified token and never from the request.
 */

export type PlaygroundPerson = {
  id: string;
  name: string;
  empId: string;
  email: string;
  roles: string[];
  empType: string;
  empStatus: string;
  currentStatus: string;
  branch: string | null;
  tone: string;
  kra: number;
  phone: string | null;
  joinedAt: string;
  openTasks: number;
  doneTasks: number;
  projects: { id: string; name: string; code: string | null; state: string; role: string }[];
};

export async function getPlayground(auth: UserAuth) {
  const companyId = auth.companyId;

  const [users, memberships, tasks] = await Promise.all([
    prisma.user.findMany({
      where: { companyId, state: { not: "disabled" } },
      select: {
        id: true,
        name: true,
        empId: true,
        email: true,
        roles: true,
        empType: true,
        empStatus: true,
        currentStatus: true,
        tone: true,
        kra: true,
        phone: true,
        joinedAt: true,
        branch: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.projectMember.findMany({
      // Only accepted memberships: an unanswered invitation is not yet a
      // contribution, and showing it would overstate what someone is on.
      where: { state: "accepted", project: { companyId } },
      select: {
        userId: true,
        role: true,
        project: { select: { id: true, name: true, code: true, state: true } },
      },
    }),
    prisma.task.findMany({
      where: { companyId },
      select: { assigneeIds: true, state: true },
    }),
  ]);

  /* project list per person */
  const projectsBy = new Map<string, PlaygroundPerson["projects"]>();
  for (const m of memberships) {
    const list = projectsBy.get(m.userId) ?? [];
    list.push({
      id: m.project.id,
      name: m.project.name,
      code: m.project.code,
      state: m.project.state,
      role: m.role,
    });
    projectsBy.set(m.userId, list);
  }

  /* task tallies per person — a task can serve several assignees, so each one
     counts it. */
  const open = new Map<string, number>();
  const done = new Map<string, number>();
  for (const task of tasks) {
    const bucket = task.state === "done" ? done : open;
    for (const id of task.assigneeIds) bucket.set(id, (bucket.get(id) ?? 0) + 1);
  }

  const people: PlaygroundPerson[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    empId: u.empId,
    email: u.email,
    roles: u.roles,
    empType: u.empType,
    empStatus: u.empStatus,
    currentStatus: u.currentStatus,
    branch: u.branch?.name ?? null,
    tone: u.tone,
    kra: u.kra,
    phone: u.phone,
    joinedAt: u.joinedAt.toISOString(),
    openTasks: open.get(u.id) ?? 0,
    doneTasks: done.get(u.id) ?? 0,
    projects: (projectsBy.get(u.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const kras = people.map((p) => p.kra);

  return {
    people,
    stats: {
      total: people.length,
      avgKra: kras.length ? Math.round(kras.reduce((a, b) => a + b, 0) / kras.length) : 0,
      branches: [...new Set(people.map((p) => p.branch).filter((b): b is string => Boolean(b)))].sort(),
      roles: [...new Set(people.flatMap((p) => p.roles))].sort(),
    },
  };
}
