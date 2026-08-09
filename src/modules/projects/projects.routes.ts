import { Router } from "express";
import { z } from "zod";
import { created, noContent, ok, pageMeta } from "../../lib/http";
import { body, idParam, objectId, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  createProjectSchema,
  inviteMembersSchema,
  listProjectsSchema,
  planSchema,
  respondSchema,
  secretsSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type ListProjectsQuery,
  type PlanInput,
  type SecretsInput,
  type UpdateProjectInput,
} from "./projects.schema";
import {
  createProject,
  deleteProject,
  getProject,
  getSecrets,
  inviteMembers,
  listProjects,
  myInvitations,
  removeMember,
  respondToInvite,
  setPlan,
  setSecrets,
  updateProject,
} from "./projects.service";

export const projectsRouter = Router();

projectsRouter.use(requireAuth, requireUser);

/*
 * Two routes sit OUTSIDE the Projects module guard, behind Requests instead.
 *
 * Requests is a baseline module everyone has, precisely so an invitation always
 * has somewhere to be answered. Someone in sales has no Projects module, but
 * can still be invited to one — gating their own invitation behind Projects
 * would leave it permanently unanswerable.
 *
 * They are scoped to the caller either way: `myInvitations` only ever reads the
 * caller's own rows, and `respondToInvite` only ever writes the caller's own
 * membership.
 */
projectsRouter.get("/invitations", requireModule("requests"), async (req, res) => {
  ok(res, await myInvitations(actor(req)));
});

/** Steps 2 and 4 — the invitee answers for themselves, and only for themselves. */
projectsRouter.post(
  "/:id/membership",
  requireModule("requests"),
  validate({ params: idParam, body: respondSchema }),
  async (req, res) => {
    const { response } = body<{ response: "accept" | "decline" }>(req);
    ok(res, await respondToInvite(actor(req), params<{ id: string }>(req).id, response));
  },
);

// Everything below needs the Projects module.
projectsRouter.use(requireModule("projects"));

projectsRouter.get("/", validate({ query: listProjectsSchema }), async (req, res) => {
  const q = query<ListProjectsQuery>(req);
  const { rows, total } = await listProjects(actor(req), q);
  ok(res, rows, pageMeta(total, q.page, q.perPage));
});

projectsRouter.post("/", validate({ body: createProjectSchema }), async (req, res) => {
  const project = await createProject(actor(req), body<CreateProjectInput>(req));
  created(res, project, `/api/v1/projects/${project.id}`);
});

projectsRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await getProject(actor(req), params<{ id: string }>(req).id));
});

projectsRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateProjectSchema }),
  async (req, res) => {
    ok(res, await updateProject(actor(req), params<{ id: string }>(req).id, body<UpdateProjectInput>(req)));
  },
);

projectsRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  await deleteProject(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});

/* --------------------------------------------------------- membership -- */

/** Step 1 — a superAdmin asks a manager or team leader to lead the project. */
projectsRouter.post(
  "/:id/managers",
  validate({ params: idParam, body: inviteMembersSchema }),
  async (req, res) => {
    const { userIds } = body<{ userIds: string[] }>(req);
    ok(res, await inviteMembers(actor(req), params<{ id: string }>(req).id, userIds, "manager"));
  },
);

/** Step 3 — an ACCEPTED manager adds employees to the team. */
projectsRouter.post(
  "/:id/members",
  validate({ params: idParam, body: inviteMembersSchema }),
  async (req, res) => {
    const { userIds } = body<{ userIds: string[] }>(req);
    ok(res, await inviteMembers(actor(req), params<{ id: string }>(req).id, userIds, "member"));
  },
);

projectsRouter.delete(
  "/:id/members/:userId",
  validate({ params: z.object({ id: objectId, userId: objectId }).strict() }),
  async (req, res) => {
    const { id, userId } = params<{ id: string; userId: string }>(req);
    await removeMember(actor(req), id, userId);
    noContent(res);
  },
);

/* --------------------------------------------------------------- plan -- */

projectsRouter.put(
  "/:id/plan",
  validate({ params: idParam, body: planSchema }),
  async (req, res) => {
    ok(res, await setPlan(actor(req), params<{ id: string }>(req).id, body<PlanInput>(req)));
  },
);

/* ------------------------------------------------------------ secrets -- */

projectsRouter.get("/:id/secrets", validate({ params: idParam }), async (req, res) => {
  ok(res, await getSecrets(actor(req), params<{ id: string }>(req).id));
});

projectsRouter.put(
  "/:id/secrets",
  validate({ params: idParam, body: secretsSchema }),
  async (req, res) => {
    ok(res, await setSecrets(actor(req), params<{ id: string }>(req).id, body<SecretsInput>(req)));
  },
);
