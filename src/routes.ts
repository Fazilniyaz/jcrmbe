import { Router } from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { inviteRouter } from "./modules/invite/invite.routes";
import { companiesRouter, masterRouter } from "./modules/companies/companies.routes";
import { referenceRouter } from "./modules/reference/reference.routes";
import { branchesRouter } from "./modules/branches/branches.routes";
import { clientsRouter } from "./modules/clients/clients.routes";
import { employeesRouter } from "./modules/employees/employees.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { tasksRouter } from "./modules/tasks/tasks.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";

/*
 * The API surface, versioned at /api/v1.
 *
 * Only `auth` and `invite` are reachable without a token; every other router
 * mounts requireAuth as its first middleware, so a new route added inside one
 * inherits the guard instead of having to remember it.
 */
export const router = Router();

router.use("/auth", authRouter);
router.use("/invite", inviteRouter);

router.use("/reference", referenceRouter);
router.use("/master", masterRouter);
router.use("/companies", companiesRouter);

router.use("/branches", branchesRouter);
router.use("/clients", clientsRouter);
router.use("/employees", employeesRouter);
router.use("/projects", projectsRouter);
router.use("/tasks", tasksRouter);
router.use("/settings", settingsRouter);
router.use("/notifications", notificationsRouter);
