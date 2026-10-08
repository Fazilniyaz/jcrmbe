import type { RequestHandler } from "express";
import { publishToCompany, publishToUser, type Resource } from "../lib/realtime";

/*
 * Who gets told what, derived from the route.
 *
 * One hook instead of a `publish()` call inside every service. A per-service
 * call is forgotten the moment someone adds an endpoint — and it was forgotten
 * in exactly that way for notifications the first time this was written by
 * hand. Deriving it from the path and the status code means a new route is
 * live by default, and the only thing to remember is to add an entry here when
 * a new top-level resource appears.
 *
 * Mounted BEFORE the router and acting on `res.finish`, so it sees the final
 * status code and `req.auth` as the auth middleware left it.
 */

/** Route segment -> what changed, and whether it is the company's business. */
const ROUTES: Record<string, { resource: Resource; scope: "company" | "user" }> = {
  tasks: { resource: "tasks", scope: "company" },
  projects: { resource: "projects", scope: "company" },
  sprints: { resource: "sprints", scope: "company" },
  employees: { resource: "employees", scope: "company" },
  teams: { resource: "teams", scope: "company" },
  clients: { resource: "clients", scope: "company" },
  branches: { resource: "branches", scope: "company" },
  clock: { resource: "clock", scope: "company" },
  reports: { resource: "reports", scope: "company" },
  playground: { resource: "playground", scope: "company" },
  // Marking a notification read is nobody else's business, and a company-wide
  // emit would have every open tab refetch its own list on every read.
  notifications: { resource: "notifications", scope: "user" },
};

/**
 * Sub-paths of /settings, which is two different things on one router.
 *
 * A status or a profile change is what the Playground and the employee list
 * are drawing, so it goes to the company. A password change or a workspace
 * preference is not. `presence` rides on `employees`, where the longer
 * coalescing window in the realtime module absorbs the heartbeats.
 */
const SETTINGS: Record<string, { resource: Resource; scope: "company" | "user" }> = {
  status: { resource: "employees", scope: "company" },
  profile: { resource: "employees", scope: "company" },
  presence: { resource: "employees", scope: "company" },
  workspace: { resource: "settings", scope: "company" },
};

const MUTATIONS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export const broadcastChanges: RequestHandler = (req, res, next) => {
  if (!MUTATIONS.has(req.method)) return next();

  res.on("finish", () => {
    // A refused write changed nothing; telling forty clients to refetch
    // because one of them was rejected is pure load.
    if (res.statusCode >= 400) return;

    const auth = req.auth;
    if (auth?.kind !== "user") return;

    const parts = req.path.split("/").filter(Boolean); // api, v1, <resource>, ...
    if (parts[0] !== "api" || parts[1] !== "v1") return;
    const head = parts[2];
    if (!head) return;

    const target =
      head === "settings" ? SETTINGS[parts[3] ?? ""] : ROUTES[head];
    if (!target) return;

    if (target.scope === "user") publishToUser(auth.userId, target.resource, auth.userId);
    else publishToCompany(auth.companyId, target.resource, auth.userId);
  });

  next();
};
