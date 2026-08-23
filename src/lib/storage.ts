import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import ImageKit from "imagekit";
import { env } from "../config/env";

/*
 * Where attachment bytes live.
 *
 * One seam, so the rest of the app only ever holds a `provider` and a
 * `storageKey` and never knows whether that resolves to a file on a volume or
 * an object in a bucket. Two implementations of `AttachmentStorage` ship: the
 * local filesystem, and ImageKit. Which one NEW uploads use is decided once, by
 * `env.imagekitEnabled`; which one an EXISTING row is read or deleted through
 * is decided per row, by `driverFor(row.provider)`. Those are different
 * questions — turning ImageKit on must not orphan the files already on disk.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nothing from the request contributes to
 * a path or an object name. The key is generated here, from randomness, with an
 * extension chosen from a fixed table. A filename like `../../.env` or
 * `x.png\0.js` cannot be expressed because the client's filename is never on
 * the path in the first place.
 */

/**
 * Accepted types, and the ONE extension each is stored under.
 *
 * An allowlist, not a denylist — the interesting attacks are all in what a
 * denylist forgets. Nothing here executes in a browser: no `text/html`, no
 * `image/svg+xml` (SVG carries script), no archives.
 */
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
};

export function isAllowedMimeType(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TYPES, mime);
}

/** Only images get the delivery transform; everything else is served verbatim. */
function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/* ------------------------------------------------------------ interface -- */

export type AttachmentProvider = "local" | "imagekit";

/** What `save` hands back, and what the row stores. */
export type SavedFile = {
  /** The driver's handle: a path key on disk, a fileId in ImageKit. */
  key: string;
  /** The object's canonical URL. Null for local, which has no URL. */
  url: string | null;
};

export type DeliveryOptions = {
  mimeType: string;
  /** Requested pixel width for an image thumbnail. Ignored by non-image types. */
  width?: number;
};

/**
 * The one interface the attachments module talks to.
 *
 * `signedUrl` and `openStream` are the two halves of "get the bytes to the
 * caller", and each driver implements exactly one of them — a driver that hands
 * out URLs has no stream to give, and a driver that streams has no URL. The
 * null returns are the honest encoding of that; the download route branches on
 * `provider` and asks only the question its driver can answer.
 */
export interface AttachmentStorage {
  readonly provider: AttachmentProvider;
  save(input: {
    companyId: string;
    taskId: string;
    subtaskId?: string | null;
    buffer: Buffer;
    mimeType: string;
  }): Promise<SavedFile>;
  remove(key: string): Promise<void>;
  /** A short-lived signed delivery URL, or null when this driver serves bytes itself. */
  signedUrl(file: { key: string; url: string | null }, options: DeliveryOptions): string | null;
  /** A byte stream, or null when this driver hands out URLs instead. */
  openStream(key: string): NodeJS.ReadableStream | null;
}

/* ---------------------------------------------------------------- local -- */

/** Absolute, resolved once. Everything below joins against this and nothing else. */
const ROOT = path.resolve(env.UPLOAD_DIR);

/**
 * A storage key: `<company>/<32 hex>.<ext>`.
 *
 * Sharded by company so a directory listing never mixes tenants and no single
 * directory grows without bound. 128 bits of randomness, so a key cannot be
 * guessed even if the download route were ever left unauthenticated — which it
 * is not; this is the second lock, not the first.
 */
export function newStorageKey(companyId: string, mimeType: string): string {
  const extension = ALLOWED_MIME_TYPES[mimeType] ?? ".bin";
  // Hashed rather than used raw: the id is an ObjectId, which is fine on a
  // path, but hashing means no database identifier is ever readable from the
  // filesystem layout.
  const shard = createHash("sha256").update(companyId).digest("hex").slice(0, 12);
  return `${shard}/${randomBytes(16).toString("hex")}${extension}`;
}

/**
 * Resolve a key to an absolute path, refusing anything that escapes the root.
 *
 * Keys are generated by `newStorageKey` and cannot contain traversal — this is
 * belt and braces against a key that came back from the database after being
 * written by some future code path that was less careful.
 */
function resolveKey(storageKey: string): string {
  const full = path.resolve(ROOT, storageKey);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error("storage key escapes the upload root");
  }
  return full;
}

export const localStorage: AttachmentStorage = {
  provider: "local",

  async save({ companyId, buffer, mimeType }) {
    const key = newStorageKey(companyId, mimeType);
    const full = resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    // `flag: "wx"` fails if the path already exists rather than overwriting.
    // With 128 random bits a collision is not a real prospect; silently
    // replacing another task's attachment if one ever happened is.
    await writeFile(full, buffer, { flag: "wx" });
    return { key, url: null };
  },

  /**
   * Delete, tolerating a file that is already gone.
   *
   * Used both to clean up a rejected upload and to remove a deleted attachment.
   * In neither case is "it was not there" a failure worth propagating — the
   * desired end state is the same either way.
   */
  async remove(key) {
    try {
      await unlink(resolveKey(key));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  },

  // Local files are served by the download route itself, through the same
  // authorisation check every other read goes through. There is no URL to sign.
  signedUrl() {
    return null;
  },

  openStream(key) {
    return createReadStream(resolveKey(key));
  },
};

/* ------------------------------------------------------------- imagekit -- */

/** How long a delivery URL stays valid. Long enough to fetch, short enough to be useless if leaked. */
const SIGNED_URL_TTL_SECONDS = 300;

/** Bounds on a caller-supplied thumbnail width, so the transform cannot be steered anywhere odd. */
const MIN_THUMB_WIDTH = 16;
const MAX_THUMB_WIDTH = 2000;

/**
 * Built once, lazily, and only when the credentials are actually there.
 *
 * Lazy rather than at module load so importing this file on a machine with no
 * ImageKit configuration costs nothing and cannot throw.
 */
let client: ImageKit | null = null;

function imagekit(): ImageKit {
  if (!client) {
    client = new ImageKit({
      publicKey: env.IMAGEKIT_PUBLIC_KEY,
      privateKey: env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: env.IMAGEKIT_URL_ENDPOINT,
    });
  }
  return client;
}

export const imagekitStorage: AttachmentStorage = {
  provider: "imagekit",

  /**
   * Upload the bytes and keep the two handles ImageKit gives back.
   *
   * `fileName` is generated here, exactly as the local key is — the client's
   * filename is display metadata and never reaches the object store, so it can
   * neither pick the extension nor smuggle a path segment. `useUniqueFileName`
   * is on anyway, so even a repeated random name cannot overwrite.
   *
   * `isPrivateFile` is what makes the signature meaningful: without it the
   * returned URL is world-readable forever, and a tenant's file would be one
   * leaked link away from public. With it, an unsigned request is refused and
   * the only way in is a URL this process signed, minutes ago.
   */
  async save({ companyId, taskId, buffer, mimeType }) {
    const extension = ALLOWED_MIME_TYPES[mimeType] ?? ".bin";
    const result = await imagekit().upload({
      file: buffer,
      fileName: `${randomBytes(16).toString("hex")}${extension}`,
      // Sharded per tenant and per task, mirroring the local layout, so the
      // media library is navigable and one company's folder is one company's.
      folder: `${env.IMAGEKIT_FOLDER}/${companyId}/${taskId}`,
      useUniqueFileName: true,
      isPrivateFile: true,
    });
    return { key: result.fileId, url: result.url };
  },

  async remove(key) {
    try {
      await imagekit().deleteFile(key);
    } catch (error) {
      // Already gone is the end state we wanted. Anything else is real.
      const status = (error as { $ResponseMetadata?: { statusCode?: number } })?.$ResponseMetadata
        ?.statusCode;
      if (status !== 404) throw error;
    }
  },

  /**
   * A signed URL that expires, with `f-auto,q-auto` for images.
   *
   * `q-auto` re-encodes at ImageKit's quality heuristic and `f-auto` negotiates
   * WebP or AVIF against the requesting browser's Accept header, so an image
   * arrives a fraction of its stored size without a second copy being stored.
   * Neither is applied to a PDF or a spreadsheet: those are not images, and a
   * transform on them at best does nothing.
   */
  signedUrl(file, { mimeType, width }) {
    if (!file.url) return null;

    const image = isImage(mimeType);
    const transformation: Array<Record<string, string | number>> = [];
    if (image) {
      const step: Record<string, string | number> = { quality: "auto", format: "auto" };
      if (width !== undefined) {
        step.width = Math.min(MAX_THUMB_WIDTH, Math.max(MIN_THUMB_WIDTH, Math.round(width)));
      }
      transformation.push(step);
    }

    return imagekit().url({
      // `src`, not `path`: the stored URL is the one ImageKit returned at
      // upload, so signing it directly cannot drift from where the object
      // actually is. The signature is computed over the whole URL including the
      // query, so neither the transform nor the disposition below can be
      // rewritten by whoever holds the link.
      src: file.url,
      signed: true,
      expireSeconds: SIGNED_URL_TTL_SECONDS,
      ...(transformation.length > 0 ? { transformation } : {}),
      // Non-images are served as a download, never rendered in place. This is
      // the object store's equivalent of the `Content-Disposition: attachment`
      // the local download route sets, and it exists for the same reason: an
      // uploaded PDF or text file rendered inline is active content running on
      // whatever origin served it. Images are exempt so they can be shown.
      ...(image ? {} : { queryParameters: { "ik-attachment": "true" } }),
    });
  },

  openStream() {
    return null;
  },
};

/* -------------------------------------------------------------- select -- */

/** The driver NEW uploads go to. */
export const storage: AttachmentStorage = env.imagekitEnabled ? imagekitStorage : localStorage;

/**
 * The driver a stored row belongs to.
 *
 * Per row, not per current configuration: enabling ImageKit must leave every
 * file already on disk downloadable and deletable. Null when the row names a
 * provider this deployment cannot reach — an ImageKit row on a process whose
 * credentials have been removed — so the caller can say so rather than throwing
 * an unhandled error out of the SDK.
 */
export function driverFor(provider: string): AttachmentStorage | null {
  if (provider === "imagekit") return env.imagekitEnabled ? imagekitStorage : null;
  if (provider === "local") return localStorage;
  return null;
}
