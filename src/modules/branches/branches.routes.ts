import { Router } from "express";
import { created, noContent, ok } from "../../lib/http";
import { body, idParam, params, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  createBranchSchema,
  setDefaultBranchSchema,
  updateBranchSchema,
  type CreateBranchInput,
  type SetDefaultBranchInput,
  type UpdateBranchInput,
} from "./branches.schema";
import {
  createBranch,
  deleteBranch,
  listBranches,
  setDefaultBranch,
  updateBranch,
} from "./branches.service";

/*
 * Branches. Reading is open to anyone with the module (the default-branch
 * banner has to say which office is in force); writing is superAdmin-only, and
 * that is checked in the service, not just here.
 */
export const branchesRouter = Router();

branchesRouter.use(requireAuth, requireUser, requireModule("branches"));

branchesRouter.get("/", async (req, res) => {
  ok(res, await listBranches(actor(req)));
});

/** Must precede /:id so "default" isn't read as an id. */
branchesRouter.put("/default", validate({ body: setDefaultBranchSchema }), async (req, res) => {
  ok(res, await setDefaultBranch(actor(req), body<SetDefaultBranchInput>(req)));
});

branchesRouter.post("/", validate({ body: createBranchSchema }), async (req, res) => {
  const branch = await createBranch(actor(req), body<CreateBranchInput>(req));
  created(res, branch, `/api/v1/branches/${branch.id}`);
});

branchesRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateBranchSchema }),
  async (req, res) => {
    ok(res, await updateBranch(actor(req), params<{ id: string }>(req).id, body<UpdateBranchInput>(req)));
  },
);

branchesRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  await deleteBranch(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});
