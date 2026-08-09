import { Router } from "express";
import { z } from "zod";
import { noContent, ok } from "../../lib/http";
import { idParam, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  clearAll,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "./notifications.service";

/*
 * Every route here is implicitly scoped to the caller — there is no id-of-someone-
 * else parameter anywhere, so there is no cross-user read to get wrong.
 */
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth, requireUser, requireModule("notifications"));

notificationsRouter.get(
  "/",
  validate({
    query: z
      .object({
        unreadOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = query<{ unreadOnly: boolean; limit: number }>(req);
    const auth = actor(req);
    const [rows, unread] = await Promise.all([listNotifications(auth, q), unreadCount(auth)]);
    ok(res, rows, { unread });
  },
);

notificationsRouter.patch("/read-all", async (req, res) => {
  ok(res, await markAllRead(actor(req)));
});

notificationsRouter.patch("/:id/read", validate({ params: idParam }), async (req, res) => {
  await markRead(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});

notificationsRouter.delete("/", async (req, res) => {
  ok(res, await clearAll(actor(req)));
});
