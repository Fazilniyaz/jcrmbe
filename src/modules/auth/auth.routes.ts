import { Router } from "express";
import { ok } from "../../lib/http";
import { body, validate } from "../../middleware/validate";
import { authLimiter } from "../../middleware/rateLimit";
import { requireAuth } from "../../middleware/auth";
import { loginSchema, masterLoginSchema, type LoginInput, type MasterLoginInput } from "./auth.schema";
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  currentUser,
  loginMaster,
  loginUser,
  rotateSession,
  revokeSession,
  setRefreshCookie,
} from "./auth.service";

export const authRouter = Router();

/** Platform owner. No database user behind it. */
authRouter.post(
  "/master/login",
  authLimiter,
  validate({ body: masterLoginSchema }),
  async (req, res) => {
    const { refreshToken, ...result } = await loginMaster(body<MasterLoginInput>(req));
    setRefreshCookie(res, refreshToken);
    ok(res, result);
  },
);

authRouter.post("/login", authLimiter, validate({ body: loginSchema }), async (req, res) => {
  const { user, accessToken, refreshToken } = await loginUser(body<LoginInput>(req));
  setRefreshCookie(res, refreshToken);
  ok(res, { user, accessToken });
});

/**
 * Rotates the refresh token; the old one is dead the moment this succeeds.
 * Answers with `user` for a company account and `master` for the platform
 * owner — the same discriminator /auth/me uses.
 */
authRouter.post("/refresh", authLimiter, async (req, res) => {
  const { refreshToken, ...session } = await rotateSession(req.cookies?.[REFRESH_COOKIE]);
  setRefreshCookie(res, refreshToken);
  ok(res, session);
});

/** Always 204, whether or not there was a session to end. */
authRouter.post("/logout", async (req, res) => {
  await revokeSession(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  res.status(204).send();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  if (req.auth?.kind === "master") {
    ok(res, {
      kind: "master",
      master: {
        email: req.auth.email,
        name: "Master Administrator",
        modules: ["dashboard", "companies", "settings"],
      },
    });
    return;
  }
  ok(res, { kind: "user", user: await currentUser(req.auth!.userId) });
});
