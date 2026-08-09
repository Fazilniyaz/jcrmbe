import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { rejectOperators } from "./middleware/validate";
import { apiLimiter } from "./middleware/rateLimit";
import { ApiError } from "./lib/errors";
import { router } from "./routes";

export function createApp() {
  const app = express();

  // Only when there really is a proxy in front: rate limiting and logging read
  // req.ip, and trusting a forwarded header without a proxy lets any client
  // claim any address.
  app.set("trust proxy", env.TRUST_PROXY ? 1 : false);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // This is a JSON API — nothing it returns is ever rendered as a document,
      // so the strictest possible policy is also the correct one.
      contentSecurityPolicy: {
        directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors({
      // An allowlist, not a reflector: `credentials: true` with a reflected
      // origin would let any site drive the API with the user's refresh cookie.
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl, health checks, server-to-server
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        callback(new ApiError(403, "cors_denied", "Origin not allowed."));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      // 4xx is normal traffic for an API with guards; only 5xx is an error.
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      customSuccessMessage(req, res) {
        return `${req.method} ${req.url} ${res.statusCode}`;
      },
    }),
  );

  app.use(rejectOperators);
  app.use(apiLimiter);

  app.get("/health", (_req, res) => {
    res.json({ data: { status: "ok", uptime: Math.round(process.uptime()) } });
  });

  app.use("/api/v1", router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
