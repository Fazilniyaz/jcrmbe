/*
 * Validates the REQUESTS the web app sends against the schemas that guard
 * them, with no database and no HTTP.
 *
 * Exists because of what the four repositories were merged out of. The app and
 * the API are developed and deployed separately, and the only thing joining
 * them is a URL plus a request shape — neither of which the compiler checks
 * across the boundary. Every body schema here is `.strict()`, so ONE extra key
 * the app sends and did not have to send is a 400 on a feature that typechecks,
 * builds, and looks finished on both sides.
 *
 * That is not hypothetical: `setMyStatus` takes `{ currentStatus, userId }` in
 * the app and must send only `currentStatus`, because `userId` exists for the
 * optimistic cache patch and the schema would reject it.
 *
 * Each case below is the payload or query string the app actually produces,
 * copied from lib/api/api.ts in the web repo. Change one there and this is
 * where it should fail.
 *
 *   npm run verify:contracts
 */
import assert from "node:assert/strict";
import type { ZodTypeAny } from "zod";

import {
  rateReportSchema,
  reportDaySchema,
  reportHistorySchema,
  upsertReportSchema,
} from "../src/modules/reports/reports.schema";
import {
  breakSchema,
  clockInSchema,
  clockOutSchema,
  clockStatsSchema,
  myShiftsSchema,
  rosterSchema,
} from "../src/modules/clock/clock.schema";
import {
  presenceSchema,
  setStatusSchema,
  updateProfileSchema,
} from "../src/modules/settings/settings.schema";
import { setStatusSchema as setEmployeeStatusSchema } from "../src/modules/employees/employees.schema";

const OID = "507f1f77bcf86cd799439011";
const DAY = "2026-10-09";

/** Express hands query strings over as strings, so parse them as it would. */
function qs(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

type Case = [name: string, schema: ZodTypeAny, input: unknown];

/* What the app sends, and must be accepted. */
const accepted: Case[] = [
  // ---------------------------------------------------------------- reports --
  ["reports: saveMyReport, with a headline", upsertReportSchema, {
    date: DAY, today: DAY, body: "<p>Shipped the grid.</p>", headline: "Grid shipped",
  }],
  ["reports: saveMyReport, headline omitted", upsertReportSchema, {
    date: DAY, today: DAY, body: "<p>Shipped the grid.</p>",
  }],
  ["reports: rateReport, with feedback", rateReportSchema, { stars: 4, feedback: "Good week." }],
  ["reports: rateReport, stars only", rateReportSchema, { stars: 1 }],
  ["reports: reportHistory, own days", reportHistorySchema, qs("?from=2026-10-01&to=2026-10-09")],
  ["reports: reportHistory, someone else's", reportHistorySchema,
    qs(`?from=2026-10-01&to=2026-10-09&userId=${OID}`)],
  ["reports: reportDay, bare", reportDaySchema, qs(`?date=${DAY}`)],
  ["reports: reportDay, searched and filtered", reportDaySchema,
    qs(`?date=${DAY}&q=anita&filter=missing`)],

  // ------------------------------------------------------------------ clock --
  ["clock: myClock sends no query at all", myShiftsSchema, qs("")],
  ["clock: clockIn, with a note", clockInSchema, { date: DAY, note: "On site." }],
  ["clock: clockIn, note omitted", clockInSchema, { date: DAY }],
  ["clock: clockOut, empty body", clockOutSchema, {}],
  ["clock: clockOut, with a note", clockOutSchema, { note: "Done." }],
  ["clock: toggleBreak, empty body", breakSchema, {}],
  ["clock: clockRoster, date only", rosterSchema, qs(`?date=${DAY}`)],
  ["clock: clockRoster, with a search", rosterSchema, qs(`?date=${DAY}&q=anita`)],
  ["clock: clockStats, own hours", clockStatsSchema, qs(`?date=${DAY}`)],
  ["clock: clockStats, someone else's", clockStatsSchema, qs(`?date=${DAY}&userId=${OID}`)],

  // -------------------------------------------------- profile and status --
  ["profile: setStatus, text and emoji", setStatusSchema,
    { text: "Heads down", emoji: "🎧", until: "2026-10-09T17:00:00.000Z" }],
  ["profile: setStatus, cleared with nulls", setStatusSchema,
    { text: null, emoji: null, until: null }],
  ["profile: touchPresence, heartbeat", presenceSchema, {}],
  ["profile: touchPresence, manual away", presenceSchema, { presence: "away" }],
  ["profile: updateProfile, display name", updateProfileSchema, { name: "Anita Rao" }],
  /*
   * Every value the header's status dropdown can produce.
   *
   * The app shows "Idle" / "Work Assigned" / "Break" / "Leave" and maps them
   * through STATUS_TO_API in lib/api/adapters.ts. These are the four strings
   * that mapping emits, so if either side's list is edited alone, this fails
   * rather than the dropdown 400-ing in someone's face.
   */
  ...(["idle", "workAssigned", "break", "leave"] as const).map(
    (currentStatus): Case => [
      `header: setMyStatus sends "${currentStatus}" (userId stays client-side)`,
      setEmployeeStatusSchema,
      { currentStatus },
    ],
  ),
];

/* What must be REJECTED, so the guards are real rather than decorative. */
const rejected: Case[] = [
  ["reports: an undeclared key is refused (.strict)", upsertReportSchema, {
    date: DAY, today: DAY, body: "<p>x</p>", userId: OID,
  }],
  ["reports: `from` after `to` is refused", reportHistorySchema,
    qs("?from=2026-10-09&to=2026-10-01")],
  ["reports: stars above 5 are refused", rateReportSchema, { stars: 6 }],
  ["reports: stars below 1 are refused", rateReportSchema, { stars: 0 }],
  ["reports: an unknown day filter is refused", reportDaySchema,
    qs(`?date=${DAY}&filter=everything`)],
  ["reports: a malformed date is refused", reportDaySchema, qs("?date=09-10-2026")],
  ["clock: a date is required for stats", clockStatsSchema, qs("")],
  ["clock: a non-ObjectId userId is refused", clockStatsSchema,
    qs(`?date=${DAY}&userId=notanobjectid`)],
  ["clock: an undeclared key on break is refused", breakSchema, { paid: true }],
  ["header: an unknown status value is refused", setEmployeeStatusSchema,
    { currentStatus: "vibing" }],
  ["header: setMyStatus with userId in the body WOULD be refused", setEmployeeStatusSchema,
    { currentStatus: "available", userId: OID }],
  ["profile: an unknown presence value is refused", presenceSchema, { presence: "invisible" }],
];

let failed = 0;

function report(ok: boolean, name: string, detail?: string) {
  if (ok) {
    console.log(`  ok    ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${name}`);
  if (detail) console.error(`        ${detail}`);
}

console.log("\n  accepts what the web app sends\n");
for (const [name, schema, input] of accepted) {
  const result = schema.safeParse(input);
  report(
    result.success,
    name,
    result.success ? undefined : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );
}

console.log("\n  refuses what it should\n");
for (const [name, schema, input] of rejected) {
  const result = schema.safeParse(input);
  report(!result.success, name, result.success ? "was ACCEPTED, but must be refused" : undefined);
}

const total = accepted.length + rejected.length;
console.log(`\n${total - failed}/${total} passed`);

// Belt and braces: the counts are part of the point, so a silently empty table
// cannot pass.
assert.ok(total > 30, "contract table shrank unexpectedly");

process.exit(failed === 0 ? 0 : 1);
