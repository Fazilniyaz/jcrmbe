import { Router } from "express";
import { z } from "zod";
import { created, noContent, ok } from "../../lib/http";
import { actor } from "../../middleware/auth";
import { objectId, params, validate } from "../../middleware/validate";
import { uploadLimiter } from "../../middleware/rateLimit";
import {
  createAttachment,
  deleteAttachment,
  getAttachmentForDownload,
  listAttachments,
} from "./attachments.service";

/*
 * /api/v1/tasks/:id/attachments
 *
 * Mounted INSIDE the tasks router with `mergeParams`, so it inherits
 * requireAuth + requireUser + requireModule("tasks") rather than restating
 * them. A route added here is guarded by construction; one added to a
 * standalone router would only be guarded if someone remembered.
 */
export const attachmentsRouter = Router({ mergeParams: true });

const taskParam = z.object({ id: objectId }).strict();
const attachmentParam = z.object({ id: objectId, attachmentId: objectId }).strict();

/**
 * Which bucket a request is about.
 *
 * A subtask id is an embedded checklist-line id (`chk_…`), NOT an ObjectId, so
 * it is read straight from the query and length-capped rather than run through
 * `objectId`. Absent means the task-level bucket, which is the unchanged
 * default every existing caller already hits.
 */
function subtaskIdOf(req: { query: Record<string, unknown> }): string | undefined {
  const raw = req.query.subtaskId;
  return typeof raw === "string" && raw.length > 0 ? raw.slice(0, 64) : undefined;
}

attachmentsRouter.get("/", validate({ params: taskParam }), async (req, res) => {
  const { id } = params<{ id: string }>(req);
  ok(res, await listAttachments(actor(req), id, subtaskIdOf(req)));
});

/*
 * Upload.
 *
 * No `validate({ body })` — the body is a multipart stream, not JSON, and
 * reading it to validate it would defeat the streaming. Everything a body
 * schema would check (type, size, count) is enforced against the stream itself
 * inside the service, which is the only place that can do it without buffering.
 */
attachmentsRouter.post("/", uploadLimiter, validate({ params: taskParam }), async (req, res) => {
  const { id } = params<{ id: string }>(req);
  const attachment = await createAttachment(actor(req), id, req, subtaskIdOf(req));
  // Points at the download, because that is the only URL that addresses a
  // single attachment — there is no GET for the metadata on its own, and a
  // Location naming a route that 404s is worse than none.
  created(res, attachment, `/api/v1/tasks/${id}/attachments/${attachment.id}/download`);
});

/**
 * How wide a thumbnail the caller wants, if any.
 *
 * Only ever a hint: the value is parsed to a finite number here and clamped to
 * a sane range by the storage driver before it reaches a transform string, so
 * nothing the caller writes can steer the URL. Absent or unparseable means the
 * full-size file, which is the unchanged default every existing caller hits.
 */
function widthOf(req: { query: Record<string, unknown> }): number | undefined {
  const raw = req.query.w;
  if (typeof raw !== "string") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Download.
 *
 * Served through here rather than from a static path, so every byte leaves
 * behind an authorisation check — including when the bytes themselves come from
 * the object store. Two shapes, one door:
 *
 *   provider "imagekit" — 302 to a signed URL that expires in minutes, with
 *     `f-auto,q-auto` applied for images. The check has already happened; what
 *     the caller gets is a capability to fetch this one object for a short
 *     while, not a permanent public link. Proxying the bytes instead would put
 *     every megabyte back through this process for no security gained.
 *   provider "local"    — streamed from disk, exactly as before.
 *
 * The headers on the streaming path are as important as the check:
 *
 *   Content-Disposition: attachment  — the browser saves it instead of
 *     rendering it. An uploaded PDF or HTML-ish text file rendered inline on
 *     the API's origin would be same-origin script against the API. The signed
 *     ImageKit URL carries `ik-attachment` for the same reason.
 *   X-Content-Type-Options: nosniff  — the declared type is the type. Without
 *     it a browser may sniff the bytes and decide a .txt is really HTML.
 *   Cache-Control: private           — a shared cache must never hold a
 *     tenant's file, nor a signed URL that grants it, and serve either to the
 *     next person through the same proxy.
 */
attachmentsRouter.get(
  "/:attachmentId/download",
  validate({ params: attachmentParam }),
  async (req, res) => {
    const { id, attachmentId } = params<{ id: string; attachmentId: string }>(req);
    const { row, signedUrl, stream } = await getAttachmentForDownload(actor(req), id, attachmentId);

    res.setHeader("Cache-Control", "private, no-store");

    const redirectTo = signedUrl(widthOf(req));
    if (redirectTo) {
      // 302, not 301: the URL is valid for five minutes, so a client that
      // cached it permanently would hold a link that is broken far longer than
      // it worked.
      res.redirect(302, redirectTo);
      return;
    }

    const file = stream();
    if (!file) {
      // Neither a URL nor bytes. Unreachable with the drivers that exist —
      // each implements one of the two — but a silent hang is the wrong way to
      // find that out if a third ever gets it wrong.
      throw new Error(`storage driver for ${row.id} offered neither a stream nor a URL`);
    }

    // The name is already stripped of quotes and control characters on the way
    // in; `filename*` carries the UTF-8 form for anything non-ASCII, and the
    // plain `filename` stays as the fallback for older clients.
    const encoded = encodeURIComponent(row.fileName);

    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Length", String(row.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${row.fileName}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");

    // A read error after the headers are out cannot become a JSON error
    // response — the status is already sent — so the connection is destroyed
    // rather than left hanging with a half-written body.
    file.on("error", () => res.destroy());
    file.pipe(res);
  },
);

attachmentsRouter.delete(
  "/:attachmentId",
  validate({ params: attachmentParam }),
  async (req, res) => {
    const { id, attachmentId } = params<{ id: string; attachmentId: string }>(req);
    await deleteAttachment(actor(req), id, attachmentId);
    noContent(res);
  },
);
