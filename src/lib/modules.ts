import type { Role } from "@prisma/client";

/*
 * The module registry — the single list of things a portal can open.
 *
 * `slug` is the canonical name used by the API and stored in User.moduleAccess.
 * `frontendSlug` is what the existing Next.js app already calls the same module
 * (lib/modules.ts uses "project-management" where the API says "projects").
 * Both are accepted on the wire so neither side had to be renamed to meet the
 * other, and `resolveModuleSlug` is the only place that knows about the two
 * vocabularies.
 */

export const MODULE_SLUGS = [
  "dashboard",
  "monitor",
  "projects",
  "tasks",
  "checklist",
  "proposedBugs",
  "communication",
  "employees",
  "performance",
  "leaveRequests",
  "clock",
  "salary",
  "payments",
  "leads",
  "clients",
  "companies",
  "branches",
  "calendar",
  "notifications",
  "requests",
  "settings",
] as const;

export type ModuleSlug = (typeof MODULE_SLUGS)[number];

const MODULE_SET = new Set<string>(MODULE_SLUGS);

/** Frontend slug -> API slug, for the five that differ. */
const FRONTEND_ALIASES: Record<string, ModuleSlug> = {
  "project-management": "projects",
  "task-management": "tasks",
  "employee-management": "employees",
  "leave-requests": "leaveRequests",
  "proposed-bugs": "proposedBugs",
};

export function isModuleSlug(value: string): value is ModuleSlug {
  return MODULE_SET.has(value);
}

/** Accepts either vocabulary; returns the canonical slug, or null if unknown. */
export function resolveModuleSlug(value: string): ModuleSlug | null {
  if (isModuleSlug(value)) return value;
  return FRONTEND_ALIASES[value] ?? null;
}

/* --------------------------------------------------------- defaults ----- */

const ALL: readonly ModuleSlug[] = MODULE_SLUGS;

/** What the master portal may open. Exactly three, per the brief. */
export const MASTER_MODULES: readonly ModuleSlug[] = ["dashboard", "companies", "settings"];

/**
 * Everyone with a login gets these regardless of role.
 *
 * Settings is where you change your own password, Notifications is how you
 * learn anything, and Requests is where you ACCEPT a project — withholding it
 * would leave an invitation with nowhere to be answered.
 */
const BASELINE: readonly ModuleSlug[] = ["settings", "notifications", "requests"];

const BY_ROLE: Record<Role, readonly ModuleSlug[]> = {
  superAdmin: ALL,
  manager: [
    "dashboard",
    "monitor",
    "projects",
    "tasks",
    "checklist",
    "proposedBugs",
    "communication",
    "employees",
    "performance",
    "leaveRequests",
    "clock",
    "calendar",
  ],
  teamLeader: [
    "dashboard",
    "monitor",
    "projects",
    "tasks",
    "checklist",
    "proposedBugs",
    "communication",
    "performance",
    "leaveRequests",
    "clock",
    "calendar",
  ],
  developer: [
    "dashboard",
    "projects",
    "tasks",
    "checklist",
    "proposedBugs",
    "communication",
    "performance",
    "leaveRequests",
    "clock",
    "calendar",
  ],
  qualityCheck: [
    "dashboard",
    "projects",
    "tasks",
    "checklist",
    "proposedBugs",
    "communication",
    "performance",
    "leaveRequests",
    "clock",
    "calendar",
  ],
  sales: [
    "dashboard",
    "leads",
    "clients",
    "communication",
    "performance",
    "leaveRequests",
    "clock",
    "calendar",
  ],
  client: ["monitor", "communication"],
  vendor: ["communication"],
};

/**
 * The modules a set of roles gets before any per-user grant is layered on.
 * superAdmin short-circuits to everything — a company owner is never partially
 * granted their own workspace.
 */
export function defaultModulesForRole(roles: readonly Role[]): ModuleSlug[] {
  if (roles.includes("superAdmin")) return [...ALL];

  const out = new Set<ModuleSlug>(BASELINE);
  for (const role of roles) for (const slug of BY_ROLE[role] ?? []) out.add(slug);
  return MODULE_SLUGS.filter((s) => out.has(s));
}

/**
 * Everything a user may open: role defaults plus the super admin's extra grants.
 * Unknown or stale entries in `moduleAccess` are ignored rather than trusted.
 */
export function effectiveModules(roles: readonly Role[], moduleAccess: readonly string[]): ModuleSlug[] {
  if (roles.includes("superAdmin")) return [...ALL];

  const allowed = new Set<ModuleSlug>(defaultModulesForRole(roles));
  for (const raw of moduleAccess) {
    const slug = resolveModuleSlug(raw);
    if (slug) allowed.add(slug);
  }
  return MODULE_SLUGS.filter((s) => allowed.has(s));
}

export function canOpenModule(
  roles: readonly Role[],
  moduleAccess: readonly string[],
  slug: ModuleSlug,
): boolean {
  if (roles.includes("superAdmin")) return true;
  return effectiveModules(roles, moduleAccess).includes(slug);
}
