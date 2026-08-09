import type { Request, RequestHandler } from "express";
import type { EmpType, Role } from "@prisma/client";
import { ApiError } from "../lib/errors";
import { verifyAccessToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { canOpenModule, effectiveModules, type ModuleSlug } from "../lib/modules";

/*
 * Who is calling, and what they are allowed to touch.
 *
 * Two rules hold everywhere below this file:
 *
 *   1. companyId comes from the verified token and the database record — never
 *      from a body, a query string or a path segment. A caller cannot name a
 *      tenant; they can only ever be in one.
 *
 *   2. Authorisation is re-read from the database on every request rather than
 *      trusted from the token. The token proves identity; the row decides
 *      rights. That is what makes "disable this employee" and "revoke this
 *      module" take effect immediately instead of at the next token expiry.
 */

export type MasterAuth = {
  kind: "master";
  email: string;
};

export type UserAuth = {
  kind: "user";
  userId: string;
  companyId: string;
  name: string;
  email: string;
  roles: Role[];
  empType: EmpType;
  isOwner: boolean;
  moduleAccess: string[];
  /** Roles + grants, resolved. */
  modules: ModuleSlug[];
};

export type AuthContext = MasterAuth | UserAuth;

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
  return value.trim() || null;
}

/**
 * Verify the access token and load the caller.
 *
 * A user token whose row has gone missing, been disabled, or whose company has
 * been disabled is rejected as unauthorised — the same answer as a bad token,
 * so a revoked account learns nothing about why.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) throw ApiError.unauthorized();

    const claims = verifyAccessToken(token);

    if (claims.kind === "master") {
      req.auth = { kind: "master", email: claims.email };
      return next();
    }

    const user = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        roles: true,
        empType: true,
        isOwner: true,
        moduleAccess: true,
        state: true,
        company: { select: { state: true } },
      },
    });

    if (
      !user ||
      user.state !== "active" ||
      user.company.state === "disabled" ||
      // The tenant in the token must still be the user's tenant. Belt and
      // braces against a token minted before a record was moved.
      user.companyId !== claims.companyId
    ) {
      throw ApiError.unauthorized("Your session is no longer valid. Sign in again.");
    }

    req.auth = {
      kind: "user",
      userId: user.id,
      companyId: user.companyId,
      name: user.name,
      email: user.email,
      roles: user.roles,
      empType: user.empType,
      isOwner: user.isOwner,
      moduleAccess: user.moduleAccess,
      modules: effectiveModules(user.roles, user.moduleAccess),
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Platform owner only — the master portal's Companies module. */
export const requireMaster: RequestHandler = (req, _res, next) => {
  if (req.auth?.kind !== "master") return next(ApiError.forbidden("Master access required."));
  next();
};

/** Any company user. Explicitly excludes the master, who has no tenant. */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (req.auth?.kind !== "user") {
    return next(ApiError.forbidden("This endpoint is for company accounts."));
  }
  next();
};

/** One of the listed roles. A company's superAdmin always passes. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (auth?.kind !== "user") return next(ApiError.forbidden());
    if (auth.roles.includes("superAdmin")) return next();
    if (!roles.some((role) => auth.roles.includes(role))) {
      return next(ApiError.forbidden("Your role doesn't allow this."));
    }
    next();
  };
}

/** Role defaults ∪ per-user grants, checked against the module registry. */
export function requireModule(slug: ModuleSlug): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) return next(ApiError.unauthorized());
    if (auth.kind === "master") {
      // The master's three modules are fixed and enumerated in the registry.
      if (slug === "dashboard" || slug === "companies" || slug === "settings") return next();
      return next(ApiError.forbidden("Not available on the master portal."));
    }
    if (!canOpenModule(auth.roles, auth.moduleAccess, slug)) {
      return next(ApiError.forbidden("That module isn't enabled for your account."));
    }
    next();
  };
}

/* ------------------------------------------------------------- helpers -- */

/** The caller as a company user, or a 403. Use at the top of every service call. */
export function actor(req: Request): UserAuth {
  if (req.auth?.kind !== "user") throw ApiError.forbidden("This endpoint is for company accounts.");
  return req.auth;
}

export function master(req: Request): MasterAuth {
  if (req.auth?.kind !== "master") throw ApiError.forbidden("Master access required.");
  return req.auth;
}

export function isSuperAdmin(auth: UserAuth): boolean {
  return auth.roles.includes("superAdmin") || auth.isOwner;
}

/** Manager, team leader, or admin-typed employee — the "can lead work" test. */
export function isLead(auth: UserAuth): boolean {
  return (
    isSuperAdmin(auth) ||
    auth.roles.includes("manager") ||
    auth.roles.includes("teamLeader") ||
    auth.empType === "manager" ||
    auth.empType === "admin"
  );
}
