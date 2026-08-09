import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { env } from "../config/env";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: `No route for ${req.method} ${req.path}.` },
  });
};

/**
 * The only place an error becomes a response.
 *
 * Anything that isn't an ApiError is a bug or a driver failure, and both are
 * answered with a bare 500. Prisma messages in particular embed the query and
 * sometimes field values, so they are logged and never forwarded.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    // 4xx below 500 is expected traffic, not an incident.
    logger.debug({ code: err.code, status: err.status, path: req.path }, "request rejected");
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: "validation_error",
        message: "Request validation failed.",
        details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      logger.warn({ target: err.meta?.target, path: req.path }, "unique constraint hit");
      res.status(409).json({
        error: { code: "conflict", message: "That value is already in use." },
      });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: { code: "not_found", message: "Not found." } });
      return;
    }
  }

  logger.error({ err, path: req.path, method: req.method }, "unhandled error");

  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong. Please try again.",
      // Never in production; even in dev this is the message only, no stack.
      ...(env.isProduction ? {} : { details: err instanceof Error ? err.message : String(err) }),
    },
  });
};
