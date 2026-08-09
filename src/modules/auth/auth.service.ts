import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { ApiError, INVALID_CREDENTIALS } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { dummyVerify, verifyPassword } from "../../lib/password";
import {
  MASTER_SUBJECT,
  durationMs,
  refreshTokenHash,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt";
import { effectiveModules } from "../../lib/modules";

/*
 * Sign-in, session rotation and sign-out.
 *
 * Nothing about a session lives in this process. The access token is
 * self-contained and the refresh token is a row — so any instance can serve any
 * request, and a restart signs nobody out.
 */

export const REFRESH_COOKIE = "jadvix_refresh";

/**
 * Scoped to the auth routes so the browser never attaches it to a data request.
 * SameSite=Lax means it does not ride along on a cross-site form post either,
 * which is the CSRF story for the refresh endpoint.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "lax" as const,
    path: "/api/v1/auth",
    maxAge: durationMs(env.REFRESH_TOKEN_TTL),
  };
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions());
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

/* --------------------------------------------------------------- lockout -- */

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * How many candidate accounts one email may be tried against.
 *
 * Email is unique per company, not globally, so the same address can exist in
 * two tenants. Rather than making the user name their company — which would
 * turn the form into a tenant-existence oracle — every candidate is checked and
 * the one whose password verifies wins. The cap bounds the argon2 work a single
 * unauthenticated request can buy.
 */
const MAX_CANDIDATES = 5;

const AUTH_USER_SELECT = {
  id: true,
  companyId: true,
  name: true,
  email: true,
  empId: true,
  roles: true,
  empType: true,
  empStatus: true,
  currentStatus: true,
  isOwner: true,
  moduleAccess: true,
  passwordHash: true,
  state: true,
  kra: true,
  openWork: true,
  branchId: true,
  phone: true,
  tone: true,
  failedLoginCount: true,
  lockedUntil: true,
  company: { select: { id: true, companyName: true, state: true, email: true, headBranch: true } },
} satisfies Prisma.UserSelect;

type AuthUser = Prisma.UserGetPayload<{ select: typeof AUTH_USER_SELECT }>;

/** The shape the frontend gets. Never includes a hash or a token field. */
export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    companyId: user.companyId,
    company: {
      id: user.company.id,
      name: user.company.companyName,
      headBranch: user.company.headBranch,
    },
    name: user.name,
    email: user.email,
    empId: user.empId,
    roles: user.roles,
    empType: user.empType,
    empStatus: user.empStatus,
    currentStatus: user.currentStatus,
    isOwner: user.isOwner,
    kra: user.kra,
    openWork: user.openWork,
    branchId: user.branchId,
    phone: user.phone,
    tone: user.tone,
    modules: effectiveModules(user.roles, user.moduleAccess),
    moduleAccess: user.moduleAccess,
  };
}

/* ----------------------------------------------------------------- login -- */

export async function loginMaster(input: { email: string; password: string }) {
  if (!env.masterLoginEnabled) {
    await dummyVerify();
    logger.error("master login attempted but MASTER_PASSWORD_HASH is not set");
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  // Compare the address too — the hash alone is not the whole credential.
  const emailMatches = input.email === env.MASTER_EMAIL.trim().toLowerCase();
  const passwordMatches = await verifyPassword(env.MASTER_PASSWORD_HASH, input.password);

  if (!emailMatches || !passwordMatches) {
    logger.warn({ email: input.email }, "failed master login");
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  // The master gets a refresh token too, or a browser reload would end the
  // session outright — the access token is deliberately in memory only.
  const { token, expiresAt } = signRefreshToken(MASTER_SUBJECT);
  await prisma.masterSession.create({
    data: { tokenHash: refreshTokenHash(token), expiresAt },
  });

  logger.info("master signed in");
  return {
    accessToken: signAccessToken({ kind: "master", email: env.MASTER_EMAIL }),
    refreshToken: token,
    master: {
      email: env.MASTER_EMAIL,
      name: "Master Administrator",
      modules: ["dashboard", "companies", "settings"] as const,
    },
  };
}

export async function loginUser(input: { email: string; password: string }) {
  const candidates = await prisma.user.findMany({
    where: { email: input.email },
    select: AUTH_USER_SELECT,
    take: MAX_CANDIDATES,
    orderBy: { joinedAt: "asc" },
  });

  if (candidates.length === 0) {
    await dummyVerify(); // keep the timing indistinguishable from a real miss
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  const now = new Date();
  let matched: AuthUser | null = null;
  const misses: AuthUser[] = [];

  for (const candidate of candidates) {
    // A locked account is skipped without a verify, so the lockout also caps
    // the work an attacker can force per request.
    if (candidate.lockedUntil && candidate.lockedUntil > now) continue;
    if (await verifyPassword(candidate.passwordHash, input.password)) {
      matched = candidate;
      break;
    }
    misses.push(candidate);
  }

  // Failures are only recorded once we know NOTHING matched. Charging every
  // candidate as it is tried would mean that when one tenant's account signs in
  // successfully, a namesake in another tenant still collects a strike — and
  // eight successful logins would lock out a stranger.
  if (!matched) {
    for (const candidate of misses) {
      await recordFailedAttempt(candidate.id, candidate.failedLoginCount);
    }
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  // Only now do the state checks, and answer them with the same message: an
  // invited-but-not-activated account must not be distinguishable from a wrong
  // password, or the invite flow becomes an account enumerator.
  if (matched.state !== "active" || !matched.passwordHash) {
    logger.warn({ userId: matched.id, state: matched.state }, "login blocked: account not active");
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }
  if (matched.company.state !== "active") {
    logger.warn({ companyId: matched.companyId }, "login blocked: company not active");
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  await prisma.user.update({
    where: { id: matched.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });

  const session = await issueSession(matched.id);

  logger.info({ userId: matched.id, companyId: matched.companyId }, "user signed in");

  return {
    user: publicUser(matched),
    accessToken: signAccessToken({
      kind: "user",
      userId: matched.id,
      companyId: matched.companyId,
      roles: matched.roles,
      isOwner: matched.isOwner,
    }),
    refreshToken: session.token,
  };
}

async function recordFailedAttempt(userId: string, current: number) {
  const next = current + 1;
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: next,
      ...(next >= MAX_FAILED_ATTEMPTS
        ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLoginCount: 0 }
        : {}),
    },
  });
  if (next >= MAX_FAILED_ATTEMPTS) {
    logger.warn({ userId }, "account locked after repeated failed logins");
  }
}

/* --------------------------------------------------------------- session -- */

async function issueSession(userId: string) {
  const { token, expiresAt } = signRefreshToken(userId);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: refreshTokenHash(token), expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Rotate a refresh token.
 *
 * The old token is revoked as part of the same operation, so a token is usable
 * exactly once. If one is presented that is already revoked, that is a replay —
 * either a stolen token or a stolen-then-used one — and every session for that
 * user is killed rather than just refusing the request.
 */
export async function rotateSession(rawToken: string | undefined) {
  if (!rawToken) throw ApiError.unauthorized("No session to refresh.");

  const claims = verifyRefreshToken(rawToken);
  const tokenHash = refreshTokenHash(rawToken);

  if (claims.userId === MASTER_SUBJECT) return rotateMasterSession(tokenHash);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, revokedAt: true },
  });

  if (!stored || stored.userId !== claims.userId) {
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  if (stored.revokedAt) {
    logger.error({ userId: stored.userId }, "refresh token replay detected — revoking all sessions");
    await revokeAllSessions(stored.userId);
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  if (stored.expiresAt <= new Date()) {
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  const user = await prisma.user.findUnique({
    where: { id: stored.userId },
    select: AUTH_USER_SELECT,
  });

  if (!user || user.state !== "active" || user.company.state !== "active") {
    await revokeAllSessions(stored.userId);
    throw ApiError.unauthorized("Your session is no longer valid. Sign in again.");
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  const session = await issueSession(user.id);

  return {
    user: publicUser(user),
    accessToken: signAccessToken({
      kind: "user",
      userId: user.id,
      companyId: user.companyId,
      roles: user.roles,
      isOwner: user.isOwner,
    }),
    refreshToken: session.token,
  };
}

/**
 * The master's half of `rotateSession`. Same rules: single use, replay kills
 * every master session.
 */
async function rotateMasterSession(tokenHash: string) {
  const stored = await prisma.masterSession.findUnique({
    where: { tokenHash },
    select: { id: true, expiresAt: true, revokedAt: true },
  });

  if (!stored) throw ApiError.unauthorized("Your session has expired. Sign in again.");

  if (stored.revokedAt) {
    logger.error("master refresh token replay detected — revoking all master sessions");
    await prisma.masterSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  if (stored.expiresAt <= new Date()) {
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  await prisma.masterSession.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

  const { token, expiresAt } = signRefreshToken(MASTER_SUBJECT);
  await prisma.masterSession.create({ data: { tokenHash: refreshTokenHash(token), expiresAt } });

  return {
    master: {
      email: env.MASTER_EMAIL,
      name: "Master Administrator",
      modules: ["dashboard", "companies", "settings"] as const,
    },
    accessToken: signAccessToken({ kind: "master", email: env.MASTER_EMAIL }),
    refreshToken: token,
  };
}

export async function revokeSession(rawToken: string | undefined) {
  if (!rawToken) return;
  const tokenHash = refreshTokenHash(rawToken);
  // Which table it belongs to is unknown here, and a miss is harmless — logout
  // is best-effort and always answers 204.
  await Promise.allSettled([
    prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.masterSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function revokeAllSessions(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/* ------------------------------------------------------------------- me -- */

export async function currentUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: AUTH_USER_SELECT });
  if (!user) throw ApiError.unauthorized();
  return publicUser(user);
}
