import crypto from "node:crypto";
import { env } from "../config/env";
import { logger } from "./logger";

/*
 * Envelope encryption for the project vault, at rest.
 *
 * WHY this exists. `SecretEntry.value` was stored exactly as typed, and the
 * schema comment said to treat the vault as low-sensitivity config only. That
 * is a reasonable boundary to draw on paper and an unreasonable one to expect
 * in practice: the UI calls itself a Secrets Vault, offers a `local /
 * development / staging / production` selector per entry, and names the field
 * with an env-style key regex. People paste real production credentials into
 * something that presents itself that way, whatever a comment says. So a
 * database snapshot, a backup, or read access to one Atlas collection handed
 * over every tenant's live keys in plaintext.
 *
 * WHAT this is. AES-256-GCM per value, with a random 96-bit IV and the auth tag
 * stored alongside. GCM rather than CBC so a tampered ciphertext fails to
 * decrypt instead of decrypting to garbage; a fresh IV per value, never
 * derived from the key or the content, so two entries holding the same
 * credential do not produce the same ciphertext.
 *
 * WHAT this is not. The key lives in the environment next to the database URL,
 * so this does not defend against someone who already has the app's
 * environment — it defends against the database being read without it, which
 * is the realistic exposure (snapshots, backups, a leaked connection string).
 * A KMS-held key is the next step and the only thing that would change here is
 * where `keyBytes` comes from.
 *
 * BACKWARD COMPATIBILITY, deliberately. Both of these hold:
 *
 *   - A value with no recognised prefix is returned as-is. Vaults written
 *     before this file existed keep working, unchanged, with no migration.
 *   - With SECRETS_KEY unset, `seal` is a pass-through. The API still boots and
 *     the vault still works on a machine that has never had a key, exactly as
 *     before, with a warning at startup rather than a failed request.
 *
 * So turning this on is: set SECRETS_KEY, restart. Values re-encrypt as they
 * are next saved; nothing has to be rewritten up front and nothing breaks if
 * the key is added late.
 */

/** Marks a value this module wrote. `v1` so the format can change later. */
const PREFIX = "enc.v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits — the size GCM is specified for
const KEY_BYTES = 32; // AES-256

/**
 * The key, decoded once.
 *
 * Accepts base64 or hex and insists on exactly 32 bytes. A short key is a
 * configuration mistake that must stop the process: silently padding it, or
 * hashing whatever was supplied up to length, would produce a vault that looks
 * encrypted and is keyed to a guessable string.
 */
const keyBytes: Buffer | null = (() => {
  const raw = env.SECRETS_KEY.trim();
  if (!raw) return null;

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (decoded.length !== KEY_BYTES) {
    // Written to stderr and fatal for the same reason config/env.ts is: a
    // half-configured secret must fail the deploy, not the first save.
    console.error(
      `SECRETS_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
    process.exit(1);
  }
  return decoded;
})();

export const secretsEncryptionEnabled = keyBytes !== null;

if (!secretsEncryptionEnabled) {
  logger.warn(
    "SECRETS_KEY is empty — project vault values are stored as plaintext. Set it to encrypt them at rest.",
  );
}

/** True for a value this module produced, so the vault can report its own state. */
export function isSealed(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

/**
 * Encrypt one vault value. Returns it unchanged when no key is configured.
 *
 * An empty string stays empty: it carries nothing to protect, and sealing it
 * would turn "this entry has no value yet" into 80 characters of ciphertext.
 */
export function seal(plain: string): string {
  if (!keyBytes || plain === "") return plain;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBytes, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(
    ".",
  );
}

/**
 * Decrypt one vault value.
 *
 * Three cases, and all three are normal:
 *
 *   not sealed      -> returned as-is (written before this file, or no key set)
 *   sealed, key ok  -> the plaintext
 *   sealed, no key  -> "" plus a warning
 *
 * That last case is the one worth being careful about. It means the key was
 * removed or rotated out from under existing data, and the honest answer is an
 * empty field the user can retype — NOT the raw ciphertext, which would look
 * like a corrupted value they should save over, and not a thrown error, which
 * would take the whole project detail response down over one unreadable row.
 */
export function open(stored: string): string {
  if (!isSealed(stored)) return stored;

  if (!keyBytes) {
    logger.error("vault value is encrypted but SECRETS_KEY is not set — cannot decrypt");
    return "";
  }

  /*
   * The prefix is stripped BEFORE splitting, because `PREFIX` itself contains
   * a dot. Splitting the whole string gives five parts — ["enc", "v1", iv,
   * tag, body] — not four, so a `parts.length !== 4` check rejected every
   * value this module had just written and the whole vault read as empty.
   * Measured from the prefix instead, the count is about the envelope's own
   * fields and stays correct whatever `PREFIX` is.
   */
  const parts = stored.slice(PREFIX.length + 1).split(".");
  if (parts.length !== 3) {
    logger.error("vault value has a malformed envelope");
    return "";
  }
  const [ivPart, tagPart, bodyPart] = parts as [string, string, string];

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      keyBytes,
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or the ciphertext was altered — GCM cannot tell us which, and
    // either way the value is not recoverable here. Never log the ciphertext.
    logger.error("vault value failed authentication — wrong SECRETS_KEY, or the row was altered");
    return "";
  }
}
