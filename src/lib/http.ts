import type { Response } from "express";

/*
 * Response shape. Every success is `{ data }`, optionally with `{ meta }`;
 * every failure is `{ error: { code, message, details? } }` from the error
 * handler. One shape means the frontend has one unwrap path.
 */

export type Meta = Record<string, unknown>;

export function ok<T>(res: Response, data: T, meta?: Meta) {
  return res.status(200).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T, location?: string) {
  if (location) res.setHeader("Location", location);
  return res.status(201).json({ data });
}

export function noContent(res: Response) {
  return res.status(204).send();
}

/** Page/perPage clamped to a sane window; list routes share it. */
export function pagination(query: { page?: unknown; perPage?: unknown }) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
  const perPage = Math.min(200, Math.max(1, Number.parseInt(String(query.perPage ?? "50"), 10) || 50));
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

export function pageMeta(total: number, page: number, perPage: number): Meta {
  return { total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}
