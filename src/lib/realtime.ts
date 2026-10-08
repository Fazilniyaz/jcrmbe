import type { Server as HttpServer } from "node:http";
import { Server as IOServer, type Socket } from "socket.io";
import { env } from "../config/env";
import { logger } from "./logger";
import { verifyAccessToken } from "./jwt";

/*
 * Realtime, as an invalidation bus.
 *
 * The socket carries NO entity data — only "something in `tasks` changed for
 * your company". Clients react by refetching through the ordinary REST
 * endpoint they already use, which is also the thing that enforces who may see
 * what.
 *
 * That is deliberate, and it is the whole design:
 *
 *   - A company room is the smallest room that is useful, and a payload pushed
 *     into it reaches everyone in the company. A task body broadcast that way
 *     would reach people whose module access forbids tasks, and a salary
 *     figure would reach the whole office. An invalidation leaks nothing: the
 *     refetch is authorised per person, so each client learns exactly what it
 *     was already allowed to ask for.
 *   - It cannot drift. A pushed payload is a second way to build the cache,
 *     and the two spellings of "a task" diverge the first time a field is
 *     added to one of them. Here there is one.
 *   - It degrades to today's behaviour. If the socket never connects — a proxy
 *     that will not upgrade, a blocked port — nothing breaks; the app is as
 *     fresh as its polling, which is what it had before this existed.
 *
 * The cost is one extra round trip per change, which is the trade being made
 * knowingly: a refetch of a list the user is looking at, against a cache that
 * can be wrong in ways nobody can reproduce.
 */

/** What changed. The client maps these onto its own cache tags. */
export const RESOURCES = [
  "tasks",
  "projects",
  "sprints",
  "employees",
  "teams",
  "clients",
  "branches",
  "clock",
  "reports",
  "playground",
  "settings",
  "notifications",
] as const;

export type Resource = (typeof RESOURCES)[number];

export type Change = {
  resource: Resource;
  /** Who caused it, so a client can ignore the echo of its own write. */
  by?: string;
  at: string;
};

let io: IOServer | null = null;

/**
 * Coalescing.
 *
 * One drag of a task across a board is several writes in a second, and a
 * presence heartbeat from forty people is forty writes a minute. Emitting each
 * one turns N clients into N refetches per write — the trailing window below
 * collapses a burst into a single "tasks changed", which is all the client can
 * act on anyway because its reaction is to refetch the whole list.
 */
const WINDOW_MS: Partial<Record<Resource, number>> = {
  // Presence and status ride on `employees`, and they are chatty by nature.
  employees: 2_000,
};
const DEFAULT_WINDOW_MS = 300;

const pending = new Map<string, { timer: NodeJS.Timeout; change: Change }>();

function roomOf(companyId: string): string {
  return `company:${companyId}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function flush(key: string, room: string) {
  const held = pending.get(key);
  if (!held) return;
  pending.delete(key);
  io?.to(room).emit("change", held.change);
}

function queue(room: string, resource: Resource, by?: string) {
  if (!io) return;
  const key = `${room}|${resource}`;
  const change: Change = { resource, by, at: new Date().toISOString() };

  const held = pending.get(key);
  if (held) {
    // Keep the window open on the first write of the burst rather than
    // restarting it, so a long drag still emits on a bounded delay.
    held.change = change;
    return;
  }

  const timer = setTimeout(() => flush(key, room), WINDOW_MS[resource] ?? DEFAULT_WINDOW_MS);
  timer.unref();
  pending.set(key, { timer, change });
}

/** Tell a company that one of its resources changed. */
export function publishToCompany(companyId: string, resource: Resource, by?: string) {
  queue(roomOf(companyId), resource, by);
}

/** Tell one person. Used for the things only they can see, e.g. notifications. */
export function publishToUser(userId: string, resource: Resource, by?: string) {
  queue(userRoom(userId), resource, by);
}

export function realtimeEnabled(): boolean {
  return io !== null;
}

/* ----------------------------------------------------------------- init -- */

async function authenticate(socket: Socket): Promise<void> {
  /*
   * The same access token as the REST API, over the handshake rather than a
   * header — socket.io's `auth` payload is the one part of the handshake a
   * browser client can set. A cookie would not do: the token is held in
   * memory by the SPA, and the refresh cookie is deliberately not readable by
   * anything that could put it here.
   */
  const raw = socket.handshake.auth?.token;
  if (typeof raw !== "string" || !raw) throw new Error("no token");

  const claims = verifyAccessToken(raw);
  if (claims.kind === "master") {
    // The master portal has no tenant, so it joins no company room. It has
    // nothing live to watch today; this keeps the connection legal rather than
    // special-casing it at the client.
    socket.join("master");
    return;
  }

  socket.join(roomOf(claims.companyId));
  socket.join(userRoom(claims.userId));
  socket.data.userId = claims.userId;
  socket.data.companyId = claims.companyId;
}

/**
 * Attach the realtime server to the HTTP server.
 *
 * Shares the port, so nothing new has to be opened or proxied beyond the
 * WebSocket upgrade headers nginx needs for /socket.io.
 */
export function initRealtime(server: HttpServer): IOServer {
  io = new IOServer(server, {
    path: "/socket.io",
    // Same allowlist as the REST API. One origin behind a reverse proxy means
    // this is usually moot, but a split deploy must not be a silent hole.
    cors: { origin: env.corsOrigins, credentials: true },
    // Long polling first, then upgrade: a proxy that refuses the upgrade still
    // gets working realtime instead of a connection that never establishes.
    transports: ["polling", "websocket"],
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      await authenticate(socket);
      next();
    } catch {
      // No detail: a socket client learns the same thing a REST client does
      // from a 401, which is nothing.
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    logger.debug({ socketId: socket.id, userId: socket.data.userId }, "socket connected");

    /*
     * A token expires while the socket stays open. Clients re-send the fresh
     * one after a refresh; the rooms are re-derived from it, and a token that
     * no longer verifies drops the connection rather than leaving a socket
     * subscribed on the strength of a credential that has expired.
     */
    socket.on("reauth", async (token: unknown, ack?: (ok: boolean) => void) => {
      try {
        socket.rooms.forEach((room) => {
          if (room !== socket.id) socket.leave(room);
        });
        socket.handshake.auth.token = typeof token === "string" ? token : "";
        await authenticate(socket);
        ack?.(true);
      } catch {
        ack?.(false);
        socket.disconnect(true);
      }
    });
  });

  logger.info("realtime enabled on /socket.io");
  return io;
}

/** Stop accepting sockets, for shutdown. */
export async function closeRealtime(): Promise<void> {
  for (const [key, held] of pending) {
    clearTimeout(held.timer);
    pending.delete(key);
  }
  const current = io;
  io = null;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
}
