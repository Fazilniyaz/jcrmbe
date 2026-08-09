import crypto from "node:crypto";

/*
 * Invite, reset and refresh tokens.
 *
 * The plaintext token is handed out once and never stored. What goes in the
 * database is a SHA-256 of it, so a database leak yields nothing usable: an
 * attacker holding the hash still cannot produce the link.
 *
 * SHA-256 rather than argon2 here on purpose — these are 256-bit random values,
 * not user-chosen secrets, so there is nothing to brute-force and the lookup has
 * to be an indexed equality match.
 */

const TOKEN_BYTES = 32;

export type IssuedToken = {
  /** Goes in the email link. Never persisted. */
  token: string;
  /** Goes in the database. */
  tokenHash: string;
  expiresAt: Date;
};

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function issueToken(ttlMs: number): IssuedToken {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

/** Constant-time compare for two hex digests of equal length. */
export function tokenMatches(candidateHash: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || storedHash.length !== candidateHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidateHash), Buffer.from(storedHash));
}

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 3 days
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
