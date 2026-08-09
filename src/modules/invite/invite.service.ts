import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { hashPassword } from "../../lib/password";
import { hashToken } from "../../lib/tokens";

/*
 * Invite acceptance.
 *
 * The token in the link is never stored; the row holds only its SHA-256. So the
 * lookup is "hash what you were given, find the row with that hash" — which
 * means a database dump cannot be turned back into working invite links.
 *
 * Single use is enforced by clearing the hash inside the same update that sets
 * the password, and by requiring the account to still be `invited`. Two requests
 * racing on the same token cannot both succeed: the second finds no hash.
 */

const GENERIC_INVALID = "That invitation link is invalid or has expired.";

type InviteTarget = {
  id: string;
  name: string;
  email: string;
  isOwner: boolean;
  companyId: string;
  companyName: string;
  state: "invited" | "active" | "disabled";
};

async function findByToken(token: string): Promise<InviteTarget> {
  const tokenHash = hashToken(token);

  const user = await prisma.user.findFirst({
    where: {
      inviteTokenHash: tokenHash,
      inviteExpiresAt: { gt: new Date() },
      state: "invited",
    },
    select: {
      id: true,
      name: true,
      email: true,
      isOwner: true,
      companyId: true,
      state: true,
      company: { select: { companyName: true, state: true } },
    },
  });

  // One message for "no such token", "expired", "already used" and "company
  // disabled" — an invite link must not confirm that an address is registered.
  if (!user || user.company.state === "disabled") {
    throw ApiError.badRequest(GENERIC_INVALID);
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isOwner: user.isOwner,
    companyId: user.companyId,
    companyName: user.company.companyName,
    state: user.state,
  };
}

/**
 * What the accept page shows before the password is typed.
 *
 * Returns the invitee's own name and company — information they already have,
 * since they received the email — and nothing else. Notably not the roles or
 * the employee id, which would be new information to whoever holds the link.
 */
export async function validateInvite(token: string) {
  const target = await findByToken(token);
  return {
    valid: true as const,
    name: target.name,
    email: target.email,
    companyName: target.companyName,
    isOwner: target.isOwner,
  };
}

/**
 * Set the password and activate.
 *
 * For a company owner this is also the moment the company itself goes active —
 * the tenant is not usable until someone can sign into it.
 */
export async function acceptInvite(token: string, password: string) {
  const target = await findByToken(token);
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    // The `state: "invited"` and non-null hash conditions make this the
    // single-use guard: a replayed token updates zero rows.
    const result = await tx.user.updateMany({
      where: { id: target.id, state: "invited", inviteTokenHash: { not: null } },
      data: {
        passwordHash,
        state: "active",
        inviteTokenHash: null,
        inviteExpiresAt: null,
        resetTokenHash: null,
        resetExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    if (result.count === 0) throw ApiError.badRequest(GENERIC_INVALID);

    if (target.isOwner) {
      await tx.company.updateMany({
        where: { id: target.companyId, state: "invited" },
        data: { state: "active" },
      });
    }
  });

  // A password change ends every other session, invited or not.
  await prisma.refreshToken.updateMany({
    where: { userId: target.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  logger.info(
    { userId: target.id, companyId: target.companyId, isOwner: target.isOwner },
    "invite accepted",
  );

  return { email: target.email, companyName: target.companyName };
}
