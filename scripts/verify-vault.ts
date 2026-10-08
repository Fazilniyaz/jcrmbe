/*
 * Round-trips the project vault's encryption, with no database and no HTTP.
 *
 * Exists because a real bug shipped here, and it was the quiet kind. `PREFIX`
 * is "enc.v1", which contains a dot, so `open` splitting the whole envelope on
 * "." got five parts where its `!== 4` guard expected four — and rejected
 * every value `seal` had just written. With SECRETS_KEY set, the vault
 * therefore read back EMPTY for everything, while still looking like it was
 * working: the write succeeded, the response echoed what the user had typed,
 * and the blanks only showed up the next time anyone opened the project.
 *
 * Nothing caught it because this is the one module whose failure mode is
 * silent by design — `open` returns "" rather than throwing, so a single
 * unreadable row cannot take down a whole project response. That is the right
 * behaviour, and it is exactly why the round-trip needs checking here instead.
 *
 *   npm run verify:vault
 *
 * A key in the environment is used as-is; without one a throwaway key is
 * generated for the run, so this needs no setup.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Set before secretBox is imported: it decodes the key once, at load.
if (!process.env.SECRETS_KEY) {
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  console.log("  (no SECRETS_KEY in the environment — generated one for this run)\n");
}

const SAMPLE = "pk_live_51Hx9QrAbCdEfGhIjKlMnOpQrStUvWxYz";

/*
 * Imported inside main(), not at the top of the file. A static import is
 * hoisted above the assignment that puts SECRETS_KEY in the environment, so
 * secretBox would load keyless and every check below would test the
 * pass-through path by accident.
 */
async function main() {
  const { isSealed, open, seal, secretsEncryptionEnabled } = await import("../src/lib/secretBox");

  const checks: [string, () => void][] = [
    [
      "a key is configured, so this run exercises the encrypting path",
      () => {
        assert.equal(secretsEncryptionEnabled, true);
      },
    ],
    [
      "a sealed value round-trips to exactly what went in",
      () => {
        // The regression. This returned "" for every possible input.
        assert.equal(open(seal(SAMPLE)), SAMPLE);
      },
    ],
    [
      "the ciphertext is not the plaintext, and announces itself as sealed",
      () => {
        const sealed = seal(SAMPLE);
        assert.notEqual(sealed, SAMPLE);
        assert.ok(!sealed.includes(SAMPLE));
        assert.equal(isSealed(sealed), true);
      },
    ],
    [
      "the same value sealed twice gives different ciphertext (fresh IV)",
      () => {
        assert.notEqual(seal(SAMPLE), seal(SAMPLE));
      },
    ],
    [
      "every shape of value round-trips, not just a short one",
      () => {
        // Lengths either side of the AES block size, plus what people actually
        // paste: multi-line keys, connection strings, unicode, base64 padding.
        const values = [
          "a",
          "x".repeat(15),
          "x".repeat(16),
          "x".repeat(17),
          "x".repeat(4096),
          "-----BEGIN KEY-----\nline two\nline three\n-----END KEY-----",
          "mongodb+srv://u:p@cluster0.abc.mongodb.net/db?retryWrites=true",
          "sk-proj-a.b.c.d",
          "pässwörd-ünïcode-🔑",
          "dGhpcyBpcyBiYXNlNjQ=",
        ];
        for (const v of values) {
          assert.equal(open(seal(v)), v, `did not round-trip ${JSON.stringify(v.slice(0, 32))}`);
        }
      },
    ],
    [
      "an empty value stays empty rather than becoming ciphertext",
      () => {
        assert.equal(seal(""), "");
        assert.equal(open(""), "");
      },
    ],
    [
      "a plaintext row written before encryption existed still reads",
      () => {
        // The compatibility promise in secretBox.ts: no prefix, no migration.
        const legacy = "plain-value-from-an-older-deployment";
        assert.equal(open(legacy), legacy);
        assert.equal(isSealed(legacy), false);
      },
    ],
    [
      "a tampered ciphertext reads empty instead of returning garbage",
      () => {
        const sealed = seal(SAMPLE);
        assert.equal(open(`${sealed.slice(0, -6)}AAAAAA`), "");
      },
    ],
    [
      "a value sealed under a different key reads empty, not garbage",
      () => {
        const cipher = crypto.createCipheriv(
          "aes-256-gcm",
          crypto.randomBytes(32),
          crypto.randomBytes(12),
        );
        const body = Buffer.concat([cipher.update(SAMPLE, "utf8"), cipher.final()]);
        const foreign = [
          "enc.v1",
          crypto.randomBytes(12).toString("base64url"),
          cipher.getAuthTag().toString("base64url"),
          body.toString("base64url"),
        ].join(".");
        assert.equal(open(foreign), "");
      },
    ],
    [
      "a truncated envelope is rejected rather than throwing",
      () => {
        assert.equal(open("enc.v1.onlyonepart"), "");
        assert.equal(open("enc.v1."), "");
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
}

void main();
