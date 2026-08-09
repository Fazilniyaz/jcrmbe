import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { ApiError } from "../lib/errors";

/*
 * Input validation, and the NoSQL operator-injection guard.
 *
 * Two layers, because either alone has a gap:
 *
 *   1. `rejectOperators` walks the raw body/query and refuses any key starting
 *      with `$` or containing a `.`. Those are Mongo's operator and dotted-path
 *      syntaxes; a value like {"$ne": null} reaching a `where` clause turns an
 *      equality check into "anything but null", which is the classic auth
 *      bypass. Rejecting at the door means no handler has to remember.
 *
 *   2. Every schema below is `.strict()` and types every scalar as a scalar, so
 *      an object arriving where a string is expected fails validation even if it
 *      carried no operator keys at all.
 */

const MAX_DEPTH = 8;

function scanForOperators(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return "nesting too deep";
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = scanForOperators(item, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$") || key.includes(".")) return key;
    if (key === "__proto__" || key === "constructor" || key === "prototype") return key;
    const bad = scanForOperators(child, depth + 1);
    if (bad) return bad;
  }
  return null;
}

/** Applied globally, before any route sees the request. */
export const rejectOperators: RequestHandler = (req, _res, next) => {
  for (const source of [req.body, req.query, req.params]) {
    const bad = source ? scanForOperators(source) : null;
    if (bad) {
      return next(ApiError.badRequest("Request contains a disallowed field name."));
    }
  }
  next();
};

/* ------------------------------------------------------------- validate -- */

export type ValidationTargets = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parse the named parts of the request and hang the result off `req.valid`.
 *
 * Express 5 makes `req.query` a getter, so nothing is written back onto the
 * request — handlers must read `req.valid`, which is also what makes it obvious
 * in review whether a handler used validated input or raw input.
 */
export function validate(targets: ValidationTargets): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const valid: NonNullable<Request["valid"]> = {};

    for (const key of ["body", "query", "params"] as const) {
      const schema = targets[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(
          ApiError.unprocessable("Request validation failed.", issuesOf(result.error)),
        );
      }
      valid[key] = result.data;
    }

    req.valid = valid;
    next();
  };
}

/** Typed accessors, so handlers don't cast at every use site. */
export function body<T>(req: Request): T {
  return req.valid?.body as T;
}
export function query<T>(req: Request): T {
  return req.valid?.query as T;
}
export function params<T>(req: Request): T {
  return req.valid?.params as T;
}

/* ------------------------------------------------------ shared schemas -- */

/**
 * A Mongo ObjectId, as a 24-character hex string.
 *
 * Typing ids this strictly is not cosmetic: Prisma throws a raw
 * `PrismaClientKnownRequestError` on a malformed ObjectId, and turning that
 * into a clean 422 here keeps driver internals out of the response.
 */
export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid id.");

export const idParam = z.object({ id: objectId }).strict();

/** Trimmed, length-bounded free text. */
export const text = (max: number, min = 1) =>
  z.string().trim().min(min).max(max);

export const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal("")).transform((v) => (v ? v : undefined));

export const email = z.string().trim().toLowerCase().email("Must be a valid email address.").max(254);

export const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date"))
  .transform((v) => new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v))
  .refine((d) => !Number.isNaN(d.getTime()), "Must be a valid date");

export const optionalIsoDate = isoDate.optional().nullable();

export const urlField = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => v === "" || /^https?:\/\//i.test(v),
    "Must be an http(s) URL.",
  );
