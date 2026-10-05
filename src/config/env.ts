import { z } from "zod";
import "dotenv/config";

/*
 * Configuration comes from the environment and nowhere else.
 *
 * Parsed once, at boot, so a missing or malformed secret fails the process
 * immediately rather than surfacing as a 500 on the first login attempt. The
 * parsed object is frozen and is the only thing the rest of the app reads —
 * process.env is never touched again.
 */

/** "15m" / "7d" / "3600" — the subset of ms-style durations jsonwebtoken takes. */
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d|w|y)?$/, "must be a duration like 15m, 7d or 3600");

const secret = z
  .string()
  .min(32, "must be at least 32 characters — generate one, do not invent it");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TRUST_PROXY: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),

  // Whether the refresh cookie carries the Secure flag. Left unset it follows
  // NODE_ENV (secure in production). Set COOKIE_SECURE=false to serve over plain
  // HTTP — a browser will not send a Secure cookie without HTTPS, which would
  // otherwise break login on an http-only deployment.
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === "" ? undefined : v === "1" || v.toLowerCase() === "true",
    ),

  /*
   * SameSite for the refresh cookie.
   *
   * `lax` is right whenever the app and the API share a registrable domain —
   * app.example.com calling api.example.com is same-site, and Lax is then both
   * sent and a CSRF defence.
   *
   * `none` is REQUIRED when they do not. Two different *.vercel.app hostnames
   * are cross-site, because `vercel.app` is on the Public Suffix List, so a Lax
   * cookie is simply never sent to the API and every session dies silently at
   * the first token refresh — a login that works and then logs you out, with
   * nothing in any log. `none` also forces `secure`, which the browser
   * requires and which is enforced below rather than left to be remembered.
   */
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).default("lax"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  ACCESS_TOKEN_TTL: duration.default("15m"),
  REFRESH_TOKEN_TTL: duration.default("7d"),

  MASTER_EMAIL: z.string().email(),
  // Optional so the API still boots before the hash has been generated; the
  // master login route refuses to authenticate anyone while it is empty.
  MASTER_PASSWORD_HASH: z.string().optional().default(""),

  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),

  GMAIL_USER: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .optional()
    .or(z.literal(""))
    .default(""),
  /*
   * Google shows an App Password as four groups of four — "abcd efgh ijkl mnop"
   * — and people paste it exactly like that. The spaces are display only; SMTP
   * AUTH would send them verbatim and Gmail would reject the login with a
   * misleading "username and password not accepted". Stripped here so the
   * pasted form just works.
   */
  GMAIL_APP_PASSWORD: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.replace(/\s+/g, "")),
  MAIL_FROM: z.string().min(1).default("Jadvix <no-reply@jadvix.local>"),

  /*
   * Where task attachments are written.
   *
   * A directory on a mounted volume, NOT anywhere under the app. Files land
   * here under a server-generated random key; nothing from the request ever
   * contributes to the path. Relative paths resolve against the process cwd.
   */
  UPLOAD_DIR: z.string().min(1).default("./var/uploads"),
  /** Hard ceiling per file. The stream is aborted the moment it is passed. */
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024),

  /*
   * ImageKit, the object store attachments actually live in once configured.
   *
   * All four are optional so the API still boots — and every upload still
   * works — on a machine that has never seen an ImageKit account. Absent, the
   * local-disk driver is used exactly as before; present, the same interface
   * is served by ImageKit instead. There is no third state: a half-filled
   * configuration is treated as absent rather than failing at the first upload.
   *
   * IMAGEKIT_PRIVATE_KEY is a SECRET and is read only by this process. It signs
   * uploads and delivery URLs server-side and must never be handed to a
   * browser; the client never talks to ImageKit directly, it talks to us.
   */
  IMAGEKIT_PUBLIC_KEY: z.string().optional().default(""),
  IMAGEKIT_PRIVATE_KEY: z.string().optional().default(""),
  IMAGEKIT_URL_ENDPOINT: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.trim().replace(/\/+$/, "")),
  /** Root folder every tenant's files are nested under. */
  IMAGEKIT_FOLDER: z
    .string()
    .optional()
    .default("/jadvix")
    .transform((v) => {
      const trimmed = v.trim().replace(/\/+$/, "");
      if (!trimmed) return "/jadvix";
      return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    }),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  // Written straight to stderr: the logger itself depends on this config.
  console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
  process.exit(1);
}

const raw = parsed.data;

export const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  /**
   * Secure flag for the refresh cookie: explicit COOKIE_SECURE wins, else
   * follows prod — EXCEPT that SameSite=None is only legal on a Secure cookie,
   * so it wins over both. A browser drops `SameSite=None` without `Secure`
   * entirely, which would look exactly like the bug the setting exists to fix.
   */
  cookieSecure:
    raw.COOKIE_SAMESITE === "none" || (raw.COOKIE_SECURE ?? raw.NODE_ENV === "production"),
  cookieSameSite: raw.COOKIE_SAMESITE,
  /** CORS_ORIGIN accepts a comma-separated list so staging can allow two hosts. */
  corsOrigins: raw.CORS_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  /** Mail is only actually sent once an App Password is present. */
  mailEnabled: Boolean(raw.GMAIL_USER && raw.GMAIL_APP_PASSWORD),
  masterLoginEnabled: raw.MASTER_PASSWORD_HASH.length > 0,
  /*
   * Attachments go to ImageKit only when all three credentials are present.
   *
   * Deliberately an all-or-nothing switch. A deployment with a URL endpoint but
   * no private key cannot sign anything, so treating it as "enabled" would fail
   * every upload; treating it as absent falls back to local disk, which works.
   */
  imagekitEnabled: Boolean(
    raw.IMAGEKIT_PRIVATE_KEY && raw.IMAGEKIT_PUBLIC_KEY && raw.IMAGEKIT_URL_ENDPOINT,
  ),
});

export type Env = typeof env;
