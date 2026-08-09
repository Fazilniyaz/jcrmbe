import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { disconnectPrisma, prisma } from "./lib/prisma";

async function main() {
  // Fail at boot rather than on the first request: a bad DATABASE_URL should
  // stop a deploy, not surface as an intermittent 500.
  await prisma.$connect();
  logger.info("database connected");

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, cors: env.corsOrigins, mail: env.mailEnabled },
      "jadvix-backend listening",
    );
    if (!env.masterLoginEnabled) {
      logger.warn("MASTER_PASSWORD_HASH is empty — master login is disabled. Run: npm run hash-master");
    }
    if (!env.mailEnabled) {
      logger.warn("GMAIL_APP_PASSWORD is empty — invite emails will be logged, not sent.");
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
    // Don't let a hung connection hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
