import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { ApiError } from "../../lib/errors";
import type { UserAuth } from "../../middleware/auth";

/*
 * Notifications.
 *
 * One row per recipient — never a broadcast. An event touching three assignees
 * writes three rows, so "mark read" and "clear" are per-person operations with
 * no shared state, exactly as the frontend store modelled it.
 *
 * Every write goes through `notify`, so recipients are de-duplicated in one
 * place: being both an assignee and a project manager on the same event should
 * not produce two copies.
 */

export type NotifyInput = {
  kind: string;
  title: string;
  detail: string;
  taskId?: string;
  projectId?: string;
};

export async function notify(
  companyId: string,
  recipients: readonly string[],
  input: NotifyInput,
): Promise<void> {
  const unique = [...new Set(recipients)].filter(Boolean);
  if (unique.length === 0) return;

  try {
    await prisma.notification.createMany({
      data: unique.map((toUserId) => ({
        companyId,
        toUserId,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
      })),
    });
  } catch (err) {
    // A notification is a side effect. Failing to write one must never fail the
    // business operation that caused it — the task was still assigned.
    logger.error({ err, kind: input.kind, companyId }, "failed to write notifications");
  }
}

export async function listNotifications(auth: UserAuth, options: { unreadOnly?: boolean; limit: number }) {
  return prisma.notification.findMany({
    where: {
      toUserId: auth.userId,
      companyId: auth.companyId,
      ...(options.unreadOnly ? { read: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
  });
}

export async function unreadCount(auth: UserAuth): Promise<number> {
  return prisma.notification.count({
    where: { toUserId: auth.userId, companyId: auth.companyId, read: false },
  });
}

/** Scoped by toUserId as well as id, so one person can't mark another's read. */
export async function markRead(auth: UserAuth, id: string) {
  const result = await prisma.notification.updateMany({
    where: { id, toUserId: auth.userId, companyId: auth.companyId },
    data: { read: true },
  });
  if (result.count === 0) throw ApiError.notFound("No such notification.");
}

export async function markAllRead(auth: UserAuth) {
  const result = await prisma.notification.updateMany({
    where: { toUserId: auth.userId, companyId: auth.companyId, read: false },
    data: { read: true },
  });
  return { updated: result.count };
}

export async function clearAll(auth: UserAuth) {
  const result = await prisma.notification.deleteMany({
    where: { toUserId: auth.userId, companyId: auth.companyId },
  });
  return { deleted: result.count };
}
