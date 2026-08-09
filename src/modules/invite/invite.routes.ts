import { Router } from "express";
import { z } from "zod";
import { ok } from "../../lib/http";
import { strongPassword } from "../../lib/password";
import { body, query, validate } from "../../middleware/validate";
import { inviteReadLimiter, passwordLimiter } from "../../middleware/rateLimit";
import { acceptInvite, validateInvite } from "./invite.service";

/*
 * Public — these are the only unauthenticated write endpoints in the API, which
 * is why both are rate limited and both answer with one generic message for
 * every failure mode.
 */
export const inviteRouter = Router();

/** base64url from crypto.randomBytes(32) is 43 characters. */
const inviteToken = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "Malformed token.");

inviteRouter.get(
  "/validate",
  inviteReadLimiter,
  validate({ query: z.object({ token: inviteToken }).strict() }),
  async (req, res) => {
    ok(res, await validateInvite(query<{ token: string }>(req).token));
  },
);

inviteRouter.post(
  "/accept",
  passwordLimiter,
  validate({
    body: z
      .object({
        token: inviteToken,
        password: strongPassword,
        confirmPassword: z.string().min(1),
      })
      .strict()
      .refine((v) => v.password === v.confirmPassword, {
        message: "The two passwords don't match.",
        path: ["confirmPassword"],
      }),
  }),
  async (req, res) => {
    const { token, password } = body<{ token: string; password: string }>(req);
    const result = await acceptInvite(token, password);
    ok(res, { ...result, message: "Your password is set. You can sign in now." });
  },
);
