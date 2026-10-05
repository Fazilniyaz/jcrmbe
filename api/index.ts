import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { logger } from "../src/lib/logger";
import { prisma } from "../src/lib/prisma";

/*
 * The Vercel entry point.
 *
 * `src/index.ts` is the long-lived server: it calls `app.listen`, waits for
 * `$connect`, and installs SIGTERM handlers. None of that applies here —
 * Vercel owns the socket and the process lifetime, and calling `listen` inside
 * a serverless function binds a port nothing will ever connect to.
 *
 * So this builds the SAME app from the same `createApp` and hands it over as a
 * request handler. There is no second copy of the middleware stack, the CORS
 * allowlist or the router: a route added to `src/routes.ts` is served here
 * without anyone remembering this file exists.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITS OF RUNNING THIS API SERVERLESS. None of these are bugs to fix
 * here; they are consequences of the platform, and docs/DEPLOY-VERCEL.md says
 * what to do about each.
 *
 *   1. Rate limiting is per-instance. `express-rate-limit`'s default store is
 *      in-process memory, and Vercel runs many short-lived instances, so the
 *      effective limit is (instances x max) and resets whenever one is
 *      recycled. The defence that actually stops credential stuffing is the
 *      database lockout (User.failedLoginCount / lockedUntil), which is
 *      unaffected. Put a Redis store behind `make()` in middleware/rateLimit.ts
 *      if you need the HTTP limit to mean something.
 *
 *   2. The filesystem is read-only apart from /tmp, and /tmp does not survive
 *      the instance. Attachments MUST go to ImageKit — set IMAGEKIT_PUBLIC_KEY,
 *      IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT, or every upload is
 *      written somewhere that is gone before anyone can read it back.
 *
 *   3. Request bodies are capped by the platform at ~4.5 MB, below this app's
 *      own UPLOAD_MAX_BYTES. A larger attachment fails at the edge, before any
 *      code here runs, so the error will not look like one of ours.
 *
 *   4. Every cold start opens a new Prisma connection pool. Use the Atlas
 *      connection limits and consider Prisma Accelerate or a pooler if the
 *      cluster starts refusing connections under load.
 * ---------------------------------------------------------------------------
 */

const app = createApp();

/*
 * Shout about the two settings that fail SILENTLY on this platform.
 *
 * Both have working defaults on a normal server and no default that can work
 * here, so neither throws — refusing to boot over a missing mail password
 * would take the whole API down for a feature most requests do not touch.
 * A warning in the function log is the honest middle: the deploy succeeds,
 * and the first person to read the log knows why their attachment vanished.
 */
if (!env.imagekitEnabled) {
  logger.error(
    "IMAGEKIT_* is unset. Vercel's filesystem is read-only apart from /tmp, and /tmp " +
      "does not survive the instance — attachments will be written somewhere that is " +
      "gone before anyone can read them back. Set the ImageKit keys.",
  );
}
if (!env.masterLoginEnabled) {
  logger.warn("MASTER_PASSWORD_HASH is empty — master login is disabled. Run: npm run hash-master");
}

/*
 * Warm the connection without blocking the first request.
 *
 * The long-lived server awaits `$connect()` before listening, so a bad
 * DATABASE_URL fails the boot. There is no boot here to fail: a serverless
 * instance IS its first request, and awaiting at module scope would add the
 * handshake to that request's latency while giving the caller nothing — Prisma
 * connects lazily on first query anyway. So this is fire-and-forget, purely to
 * overlap the handshake with the rest of module initialisation, and a failure
 * is logged rather than thrown so the request still reaches the error handler
 * and returns a proper 500 instead of an opaque platform crash.
 */
void prisma.$connect().catch((err) => {
  logger.error({ err }, "prisma connect failed on cold start");
});

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return app(req as never, res as never);
}
