/*
 * Presence — who is online, derived rather than stored.
 *
 * A boolean column would be wrong: it only changes when something remembers to
 * change it, so a crashed tab, a shut laptop or a killed process leaves a green
 * dot burning next to someone who went home. Instead the open app stamps
 * `lastSeenAt` on a heartbeat and "online" means "stamped recently" — absence
 * of news IS the news, and nobody has to clean up after a client that vanished.
 *
 * WINDOW is deliberately a little over twice the client's heartbeat interval,
 * so one dropped request does not blink someone offline.
 */

export const HEARTBEAT_MS = 60_000;
export const ONLINE_WINDOW_MS = 150_000;

export type Presence = "online" | "away" | "offline";

export function presenceOf(user: {
  presence?: string | null;
  lastSeenAt?: Date | null;
}): Presence {
  const seen = user.lastSeenAt ? Date.now() - user.lastSeenAt.getTime() : Infinity;
  if (seen > ONLINE_WINDOW_MS) return "offline";
  // Connected, but has said they are not available.
  return user.presence === "away" ? "away" : "online";
}

/** A status whose `until` has passed is no status at all. See the User model. */
export function liveStatus(user: {
  statusText?: string | null;
  statusEmoji?: string | null;
  statusUntil?: Date | null;
}) {
  const lapsed = user.statusUntil ? user.statusUntil.getTime() < Date.now() : false;
  if (lapsed || (!user.statusText && !user.statusEmoji)) {
    return { text: null, emoji: null, until: null };
  }
  return {
    text: user.statusText ?? null,
    emoji: user.statusEmoji ?? null,
    until: user.statusUntil ? user.statusUntil.toISOString() : null,
  };
}
