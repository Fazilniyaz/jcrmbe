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

/* ------------------------------------------------------- access levels -- */

/**
 * How much of a module someone gets.
 *
 *   view  they may read it. Every mutating request is refused.
 *   edit  the full module, as before.
 *
 * `edit` is the default everywhere, so nothing that worked before this existed
 * changes: a role default is `edit`, and a bare grant string is `edit`.
 */
export const ACCESS_LEVELS = ["view", "edit"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** What a user may open, and at what level. Absent = no access. */
export type ModuleLevels = Partial<Record<ModuleSlug, AccessLevel>>;

/**
 * One stored grant.
 *
 * Written as `"<slug>"` or `"<slug>:<level>"`. The bare form predates levels
 * and still means `edit`, so existing rows keep working untouched.
 */
export function parseGrant(raw: string): { slug: ModuleSlug; level: AccessLevel } | null {
  const [slugPart, levelPart] = raw.split(":");
  const slug = resolveModuleSlug((slugPart ?? "").trim());
  if (!slug) return null;
  return { slug, level: levelPart === "view" ? "view" : "edit" };
}

export function formatGrant(slug: ModuleSlug, level: AccessLevel): string {
  return `${slug}:${level}`;
}

/**
 * Everything a user may open, resolved to a level.
 *
 * Role defaults come in at `edit`; an explicit grant then OVERRIDES that,
 * which is what lets a super admin reduce a role's own module to view-only.
 * Unknown or stale entries are ignored rather than trusted.
 */
export function moduleLevels(
  roles: readonly Role[],
  moduleAccess: readonly string[],
): ModuleLevels {
  const out: ModuleLevels = {};

  if (roles.includes("superAdmin")) {
    for (const slug of ALL) out[slug] = "edit";
    return out;
  }

  for (const slug of defaultModulesForRole(roles)) out[slug] = "edit";
  for (const raw of moduleAccess) {
    const grant = parseGrant(raw);
    if (grant) out[grant.slug] = grant.level;
  }
  return out;
}

/** The level for one module, or null when they cannot open it at all. */
export function levelFor(
  roles: readonly Role[],
  moduleAccess: readonly string[],
  slug: ModuleSlug,
): AccessLevel | null {
  return moduleLevels(roles, moduleAccess)[slug] ?? null;
}

/**
 * Everything a user may open. View-only modules are included — they are still
 * on the menu, they just refuse writes.
 */
export function effectiveModules(roles: readonly Role[], moduleAccess: readonly string[]): ModuleSlug[] {
  const levels = moduleLevels(roles, moduleAccess);
  return MODULE_SLUGS.filter((s) => levels[s] !== undefined);
}

export function canOpenModule(
  roles: readonly Role[],
  moduleAccess: readonly string[],
  slug: ModuleSlug,
): boolean {
  return moduleLevels(roles, moduleAccess)[slug] !== undefined;
}
