import argon2 from "argon2";
import { z } from "zod";

/*
 * Password hashing and the strength policy.
 *
 * argon2id with explicit parameters rather than the library defaults, so the
 * cost is a decision recorded here instead of whatever a future release picks.
 * 19 MiB / 2 passes is the OWASP Password Storage Cheat Sheet's second option.
 */

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

/**
 * Verify a password. Never throws on a malformed stored hash — a corrupt or
 * absent hash is simply "wrong password", not a 500 that reveals the account
 * exists in a broken state.
 */
export async function verifyPassword(hash: string | null | undefined, plain: string): Promise<boolean> {
  if (!hash) {
    // Equalise timing against the has-a-password path so a missing hash is not
    // detectable as a faster response.
    await dummyVerify();
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/*
 * A real argon2 verification against a throwaway hash, used to keep the "no
 * such user" path as slow as the "wrong password" path. Computed once, lazily.
 */
let dummyHash: Promise<string> | null = null;
export async function dummyVerify(): Promise<void> {
  dummyHash ??= argon2.hash("password-that-is-never-correct", ARGON_OPTIONS);
  try {
    await argon2.verify(await dummyHash, "definitely-not-it");
  } catch {
    /* ignore — the point is the work, not the answer */
  }
}

/* ------------------------------------------------------------- strength -- */

const MIN_LENGTH = 12;
const MAX_LENGTH = 200; // argon2 is happy with more; the cap stops DoS-by-megabyte

/**
 * Substrings that make a password guessable regardless of how the character
 * classes work out. Checked case-insensitively against the whole string, which
 * catches "Password@2024!" — technically compliant, practically a top-10 guess.
 */
const BANNED_PATTERNS = [
  "password",
  "passw0rd",
  "qwerty",
  "asdfgh",
  "zxcvbn",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "iloveyou",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "master",
  "login",
  "abc123",
  "111111",
  "123456",
  "654321",
  "000000",
  "changeme",
  "jadvix",
];

const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop"];

/** Four or more characters running in sequence, forwards or backwards. */
function hasRun(value: string): boolean {
  const lower = value.toLowerCase();
  for (const seq of SEQUENCES) {
    const reversed = [...seq].reverse().join("");
    for (const source of [seq, reversed]) {
      for (let i = 0; i + 4 <= source.length; i += 1) {
        if (lower.includes(source.slice(i, i + 4))) return true;
      }
    }
  }
  return false;
}

/** The same character four or more times running: "aaaa", "!!!!". */
function hasRepeat(value: string): boolean {
  return /(.)\1{3,}/.test(value);
}

export type PasswordProblem = string;

/** Every reason the password is rejected, so the form can list them at once. */
export function passwordProblems(value: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];

  if (value.length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters.`);
  if (value.length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters.`);
  if (!/[a-z]/.test(value)) problems.push("Include a lowercase letter.");
  if (!/[A-Z]/.test(value)) problems.push("Include an uppercase letter.");
  if (!/[0-9]/.test(value)) problems.push("Include a number.");
  if (!/[^A-Za-z0-9]/.test(value)) problems.push("Include a symbol.");
  if (/\s{2,}/.test(value)) problems.push("Avoid runs of whitespace.");

  const lower = value.toLowerCase();
  if (BANNED_PATTERNS.some((p) => lower.includes(p))) {
    problems.push("Avoid common words and predictable patterns.");
  }
  if (hasRun(value)) problems.push("Avoid sequences like 1234 or abcd.");
  if (hasRepeat(value)) problems.push("Avoid repeating the same character four or more times.");

  return problems;
}

/**
 * The zod schema every set-password and change-password route uses.
 *
 * Typed as `z.string()` first so a JSON object or array is rejected before the
 * refinements ever run — that is also the operator-injection guard for this
 * field.
 */
export const strongPassword = z
  .string()
  .min(1, "A password is required.")
  .superRefine((value, ctx) => {
    for (const message of passwordProblems(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
