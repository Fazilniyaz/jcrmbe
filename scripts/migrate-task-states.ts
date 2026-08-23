import { PrismaClient } from "@prisma/client";

/*
 * One-off: rewrite Task.state from the old six-value vocabulary to the four
 * board columns.
 *
 *   todo, backlog        -> notStarted
 *   inProgress, inReview -> working
 *   blocked              -> stuck
 *   done, failed         -> unchanged
 *
 * Run it BEFORE anything reads tasks through the Prisma client. Mongo stores
 * enums as plain strings and does not validate them, so `prisma db push` will
 * happily leave `inReview` in place — but the generated client throws on read
 * for a value that is not in the enum, which takes the whole Tasks module down
 * rather than showing one task in the wrong column.
 *
 * That same fact is why this uses $runCommandRaw rather than prisma.task: the
 * typed client cannot so much as SELECT a row whose state it considers invalid,
 * so it cannot be the thing that fixes it.
 *
 * Idempotent — a second run matches nothing and reports zeroes.
 *
 *   npm run migrate:task-states         # report only, writes nothing
 *   npm run migrate:task-states:apply   # actually rewrite
 *
 * DRY RUN IS THE DEFAULT, and writing needs an explicit opt-in, because
 * `npm run x -- --flag` does not forward the flag on Windows npm — it is
 * silently dropped. With the polarity the other way round, a lost flag turns a
 * report into an unasked-for rewrite of every task in the database. This way a
 * lost flag costs you a second command.
 *
 * The opt-in is read from the environment as well as argv for the same reason:
 * the env var is the half that survives npm on every platform.
 */

const MAPPING: Record<string, string> = {
  todo: "notStarted",
  backlog: "notStarted",
  inProgress: "working",
  inReview: "working",
  blocked: "stuck",
};

type CountResult = { n?: number; ok?: number };
type UpdateResult = { nModified?: number; n?: number };

const prisma = new PrismaClient();

async function countState(state: string): Promise<number> {
  const result = (await prisma.$runCommandRaw({
    count: "Task",
    query: { state },
  })) as CountResult;
  return result.n ?? 0;
}

async function main() {
  const apply = process.argv.includes("--apply") || process.env.MIGRATE_APPLY === "1";
  const dryRun = !apply;

  console.log(
    dryRun
      ? "Task state migration — DRY RUN, nothing will be written.\n"
      : "Task state migration — APPLYING, rows will be rewritten.\n",
  );

  const before: Record<string, number> = {};
  for (const from of Object.keys(MAPPING)) before[from] = await countState(from);

  const total = Object.values(before).reduce((n, c) => n + c, 0);
  for (const [from, to] of Object.entries(MAPPING)) {
    console.log(`  ${from.padEnd(12)} -> ${to.padEnd(12)} ${before[from]} row(s)`);
  }
  console.log(`\n  ${total} row(s) to rewrite.`);

  if (total === 0) {
    console.log("\nNothing to do — already migrated.");
    return;
  }

  if (dryRun) {
    console.log("\nDry run: no changes made. Run `npm run migrate:task-states:apply` to rewrite.");
    return;
  }

  let written = 0;
  for (const [from, to] of Object.entries(MAPPING)) {
    if (before[from] === 0) continue;
    const result = (await prisma.$runCommandRaw({
      update: "Task",
      updates: [{ q: { state: from }, u: { $set: { state: to } }, multi: true }],
    })) as UpdateResult;
    const n = result.nModified ?? 0;
    written += n;
    console.log(`  rewrote ${n} row(s): ${from} -> ${to}`);
  }

  // Read back rather than trusting the write count: this is the check that the
  // Prisma client will not throw on the next request.
  const leftover: string[] = [];
  for (const from of Object.keys(MAPPING)) {
    if ((await countState(from)) > 0) leftover.push(from);
  }

  console.log(`\n${written} row(s) rewritten.`);
  if (leftover.length > 0) {
    console.error(`STILL PRESENT: ${leftover.join(", ")} — re-run before starting the API.`);
    process.exitCode = 1;
  } else {
    console.log("No old states remain.");
  }
}

main()
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
