import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "./logger";

/*
 * One client for the process. Prisma pools connections internally, so a second
 * instance would double the pool against Atlas for no benefit — and under
 * `tsx watch` would leak a pool per reload, which is why the handle is cached
 * on globalThis outside production.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/*
 * Interactive transaction budget.
 *
 * Prisma's defaults — 2s to acquire a connection, 5s for the whole transaction
 * — assume a database on the same network. Ours is Atlas, and the clock starts
 * at `$transaction(...)`, before the connection is acquired and before the
 * session that begins the transaction has made its first round trip. On a cold
 * or distant cluster that preamble alone can outlast 5s, so a transaction whose
 * body is two small writes dies with "transaction already closed" having done
 * no work at all.
 *
 * These numbers buy room for latency, not for long-running work: nothing in
 * this codebase does anything but writes inside a transaction. Both stay well
 * under MongoDB's own 60s transactionLifetimeLimitSeconds, which is the real
 * ceiling — a transaction that reaches it is aborted by the server regardless
 * of what we ask for here.
 */
const TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 20_000,
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isProduction ? ["warn", "error"] : ["warn", "error"],
    transactionOptions: TRANSACTION_OPTIONS,
  });

if (!env.isProduction) globalForPrisma.prisma = prisma;

export async function disconnectPrisma() {
  await prisma.$disconnect().catch((err) => logger.error({ err }, "prisma disconnect failed"));
}
