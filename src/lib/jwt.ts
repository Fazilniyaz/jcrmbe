import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../config/env";
import { ApiError } from "./errors";

/*
 * Tokens.
 *
 * Access token  — short-lived JWT, sent in the Authorization header, never a
 *                 cookie, so it is not attached automatically and CSRF has
 *                 nothing to ride on.
 * Refresh token — long-lived JWT in an httpOnly cookie, but ALSO recorded in
 *                 the RefreshToken table by hash. The signature alone is never
 *                 sufficient: a token has to be present, unexpired and
 *                 unrevoked in the database to be accepted, which is what makes
 *                 logout and rotation actually revoke anything.
 *
 * Issuer/audience are pinned so a refresh token can never be replayed as an
 * access token even if the two secrets were ever set to the same value.
 */

const ISSUER = "jadvix-api";
const ACCESS_AUD = "jadvix-access";
const REFRESH_AUD = "jadvix-refresh";

export type MasterClaims = {
  kind: "master";
  email: string;
};

export type UserClaims = {
  kind: "user";
  userId: string;
  companyId: string;
  roles: Role[];
  isOwner: boolean;
};

export type AccessClaims = MasterClaims | UserClaims;

export function signAccessToken(claims: AccessClaims): string {
  const options: SignOptions = {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
    issuer: ISSUER,
    audience: ACCESS_AUD,
    subject: claims.kind === "master" ? claims.email : claims.userId,
  };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessClaims {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: ACCESS_AUD,
      algorithms: ["HS256"], // pinned: never let the token choose, incl. "none"
    });
  } catch {
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  if (!payload || typeof payload !== "object") throw ApiError.unauthorized();
  const claims = payload as Partial<UserClaims> & Partial<MasterClaims>;

  if (claims.kind === "master" && typeof claims.email === "string") {
    return { kind: "master", email: claims.email };
  }
  if (
    claims.kind === "user" &&
    typeof claims.userId === "string" &&
    typeof claims.companyId === "string" &&
    Array.isArray(claims.roles)
  ) {
    return {
      kind: "user",
      userId: claims.userId,
      companyId: claims.companyId,
      roles: claims.roles as Role[],
      isOwner: Boolean(claims.isOwner),
    };
  }
  throw ApiError.unauthorized();
}

/* -------------------------------------------------------------- refresh -- */

/**
 * The subject a master refresh token carries in place of a user id.
 *
 * A 24-char hex ObjectId can never collide with it, so a master token can never
 * be mistaken for a user's and vice versa.
 */
export const MASTER_SUBJECT = "master";

export type RefreshClaims = { userId: string; jti: string };

export function signRefreshToken(userId: string): { token: string; jti: string; expiresAt: Date } {
  const jti = crypto.randomUUID();
  // `jti` is set through the `jwtid` OPTION and must not also appear in the
  // payload — jsonwebtoken rejects the pair outright rather than picking one.
  // It lands in the claims either way, so verifyRefreshToken still reads it.
  const token = jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.REFRESH_TOKEN_TTL as SignOptions["expiresIn"],
    issuer: ISSUER,
    audience: REFRESH_AUD,
    subject: userId,
    jwtid: jti,
  });
  return { token, jti, expiresAt: new Date(Date.now() + durationMs(env.REFRESH_TOKEN_TTL)) };
}

export function verifyRefreshToken(token: string): RefreshClaims {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: ISSUER,
      audience: REFRESH_AUD,
      algorithms: ["HS256"],
    }) as Partial<RefreshClaims>;

    if (typeof payload.userId !== "string" || typeof payload.jti !== "string") {
      throw new Error("malformed");
    }
    return { userId: payload.userId, jti: payload.jti };
  } catch {
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }
}

/** SHA-256 of the whole token string — what actually goes in the database. */
export function refreshTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------ duration -- */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/** "7d" -> 604800000. The env schema has already proved the shape. */
export function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/.exec(value);
  if (!match?.[1]) return 0;
  const unit = match[2] ?? "s";
  return Number(match[1]) * (UNIT_MS[unit] ?? 1000);
}
