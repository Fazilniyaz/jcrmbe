import pino from "pino";
import { env } from "../config/env";

/*
 * Structured logging.
 *
 * The redact list is not decoration: request bodies flow through the HTTP
 * logger, and a login body carries a plaintext password. Anything that could
 * hold a credential, a token or a hash is stripped before serialisation, so a
 * log shipper never receives one.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.currentPassword",
      "*.newPassword",
      "*.passwordHash",
      "*.token",
      "*.refreshToken",
      "*.accessToken",
      "*.inviteTokenHash",
      "*.resetTokenHash",
      "*.tokenHash",
      "*.secrets",
      "password",
      "token",
    ],
    censor: "[redacted]",
  },
  ...(env.isProduction
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
});
