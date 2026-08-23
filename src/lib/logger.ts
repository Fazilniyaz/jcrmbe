import pino from "pino";
import { env } from "../config/env";

/*
 * Structured logging.
 *
 * The redact list is not decoration: request and response headers flow through
 * the HTTP logger, and a login body carries a plaintext password. Anything that
 * could hold a credential, a token, a hash or a capability URL is stripped
 * before serialisation, so a log shipper never receives one.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      // An attachment download answers with a 302 whose Location is a signed,
      // expiring URL for a tenant's file. That URL IS the authorisation — it
      // works for anyone holding it until it expires — so it is a credential
      // and belongs in a log no more than a cookie does.
      "res.headers.location",
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
