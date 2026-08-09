/*
 * Round-trips every token this API issues, with no database and no HTTP.
 *
 * Exists because a real bug shipped here: `jti` was set both in the refresh
 * payload and via the `jwtid` option, which jsonwebtoken rejects — so every
 * login 500'd, and nothing caught it until someone actually signed in. These
 * are the four paths that must hold, and they cost 200ms to check.
 *
 *   npm run verify:tokens
 */
import assert from "node:assert/strict";
import {
  refreshTokenHash,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../src/lib/jwt";

const checks: [string, () => void][] = [
  [
    "user access token round-trips with its claims intact",
    () => {
      const token = signAccessToken({
        kind: "user",
        userId: "507f1f77bcf86cd799439011",
        companyId: "507f1f77bcf86cd799439012",
        roles: ["superAdmin"],
        isOwner: true,
      });
      const claims = verifyAccessToken(token);
      assert.equal(claims.kind, "user");
      assert.equal(claims.kind === "user" && claims.userId, "507f1f77bcf86cd799439011");
      assert.equal(claims.kind === "user" && claims.companyId, "507f1f77bcf86cd799439012");
      assert.deepEqual(claims.kind === "user" && claims.roles, ["superAdmin"]);
    },
  ],
  [
    "master access token round-trips",
    () => {
      const token = signAccessToken({ kind: "master", email: "owner@example.com" });
      const claims = verifyAccessToken(token);
      assert.equal(claims.kind, "master");
      assert.equal(claims.kind === "master" && claims.email, "owner@example.com");
    },
  ],
  [
    "refresh token signs, and verifies back to the same userId and jti",
    () => {
      const { token, jti } = signRefreshToken("507f1f77bcf86cd799439011");
      const claims = verifyRefreshToken(token);
      assert.equal(claims.userId, "507f1f77bcf86cd799439011");
      assert.equal(claims.jti, jti, "jti must survive the round trip");
      assert.equal(refreshTokenHash(token).length, 64, "hash is a sha256 hex digest");
    },
  ],
  [
    "a refresh token is rejected as an access token, and vice versa",
    () => {
      // The audience pin is what stops the long-lived token being spent as the
      // short-lived one if the two secrets were ever set to the same value.
      const { token: refresh } = signRefreshToken("507f1f77bcf86cd799439011");
      assert.throws(() => verifyAccessToken(refresh));

      const access = signAccessToken({ kind: "master", email: "owner@example.com" });
      assert.throws(() => verifyRefreshToken(access));
    },
  ],
  [
    "a tampered token is rejected",
    () => {
      const token = signAccessToken({ kind: "master", email: "owner@example.com" });
      const [header, payload, signature] = token.split(".");
      const forged = `${header}.${Buffer.from(
        JSON.stringify({ kind: "master", email: "attacker@example.com" }),
      ).toString("base64url")}.${signature}`;
      assert.throws(() => verifyAccessToken(forged));
      assert.ok(payload);
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
