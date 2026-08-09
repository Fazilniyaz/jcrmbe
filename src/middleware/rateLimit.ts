import rateLimit, { type Options } from "express-rate-limit";
import { ApiError } from "../lib/errors";

/*
 * Rate limits.
 *
 * The default store is in-process, which is the one piece of instance state in
 * the app. That is deliberate and safe to scale horizontally: with N instances
 * behind a balancer each enforces its own share, so the effective limit rises
 * to N x max but never disappears. Correctness never depends on it — the
 * account lockout that actually stops credential stuffing lives in the database
 * (User.failedLoginCount / lockedUntil) precisely so it survives a restart and
 * is shared across instances. Swap in a Redis store when there is one.
 */

const MINUTE = 60 * 1000;

function make(options: Partial<Options> & { max: number; windowMs: number }) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(ApiError.tooMany()),
    // The key is req.ip, and req.ip only honours X-Forwarded-For when
    // `trust proxy` is set — which app.ts does solely when TRUST_PROXY=1. With
    // no proxy configured a forged header cannot buy a fresh bucket.
    ...options,
  });
}

/** Everything under /auth and /invite. Tight, because these are the doors. */
export const authLimiter = make({ windowMs: 15 * MINUTE, max: 20 });

/** Password set/change — even tighter, and counted separately. */
export const passwordLimiter = make({ windowMs: 60 * MINUTE, max: 10 });

/** Invite validation is a GET the frontend calls on page load, so a bit looser. */
export const inviteReadLimiter = make({ windowMs: 15 * MINUTE, max: 60 });

/** Anything that sends an email, keyed per IP. */
export const mailLimiter = make({ windowMs: 60 * MINUTE, max: 30 });

/** The blanket limit for the authenticated API. */
export const apiLimiter = make({ windowMs: MINUTE, max: 300 });
