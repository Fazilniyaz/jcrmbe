import { Router } from "express";
import { z } from "zod";
import { ok } from "../../lib/http";
import { body, objectId, params, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import { passwordLimiter } from "../../middleware/rateLimit";
import {
  changePasswordSchema,
  setModuleAccessSchema,
  updateProfileSchema,
  workspaceSchema,
  type ChangePasswordInput,
  type SetModuleAccessInput,
  type UpdateProfileInput,
  type WorkspaceInput,
} from "./settings.schema";
import {
  changePassword,
  getProfile,
  getWorkspace,
  listModuleAccess,
  moduleRegistry,
  setModuleAccess,
  updateProfile,
  updateWorkspace,
} from "./settings.service";

export const settingsRouter = Router();

settingsRouter.use(requireAuth, requireUser, requireModule("settings"));

settingsRouter.get("/profile", async (req, res) => {
  ok(res, await getProfile(actor(req)));
});

settingsRouter.patch("/profile", validate({ body: updateProfileSchema }), async (req, res) => {
  ok(res, await updateProfile(actor(req), body<UpdateProfileInput>(req)));
});

settingsRouter.post(
  "/password",
  passwordLimiter,
  validate({ body: changePasswordSchema }),
  async (req, res) => {
    ok(res, await changePassword(actor(req), body<ChangePasswordInput>(req)));
  },
);

settingsRouter.get("/modules", (req, res) => {
  ok(res, moduleRegistry(actor(req)));
});

settingsRouter.get("/module-access", async (req, res) => {
  ok(res, await listModuleAccess(actor(req)));
});

settingsRouter.put(
  "/module-access/:userId",
  validate({ params: z.object({ userId: objectId }).strict(), body: setModuleAccessSchema }),
  async (req, res) => {
    const { userId } = params<{ userId: string }>(req);
    ok(res, await setModuleAccess(actor(req), userId, body<SetModuleAccessInput>(req)));
  },
);

settingsRouter.get("/workspace", async (req, res) => {
  ok(res, await getWorkspace(actor(req)));
});

settingsRouter.patch("/workspace", validate({ body: workspaceSchema }), async (req, res) => {
  ok(res, await updateWorkspace(actor(req), body<WorkspaceInput>(req)));
});
