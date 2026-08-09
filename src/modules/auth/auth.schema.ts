import { z } from "zod";
import { email } from "../../middleware/validate";

/*
 * Passwords are typed as a bare bounded string on the way IN — the policy is
 * only enforced where a password is being SET. Applying the strength rules to a
 * login would tell an attacker whether a stored password meets them.
 */
const submittedPassword = z.string().min(1, "A password is required.").max(200);

export const masterLoginSchema = z
  .object({
    email,
    password: submittedPassword,
  })
  .strict();

export const loginSchema = z
  .object({
    email,
    password: submittedPassword,
  })
  .strict();

export type MasterLoginInput = z.infer<typeof masterLoginSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
