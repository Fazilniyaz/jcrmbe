import { Router } from "express";
import { ok } from "../../lib/http";
import { body, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  breakSchema,
  clockInSchema,
  clockOutSchema,
  clockStatsSchema,
  myShiftsSchema,
  rosterSchema,
  type ClockInInput,
  type ClockOutInput,
  type ClockStatsQuery,
  type MyShiftsQuery,
  type RosterQuery,
} from "./clock.schema";
import {
  clockIn,
  clockOut,
  getClockStats,
  getMyClock,
  getRoster,
  toggleBreak,
} from "./clock.service";

/*
 * Clock.
 *
 * Note the two levels. Your own attendance is `clock` at whatever level you
 * have — clocking in is a write, so view-only access can watch the week and
 * not punch the card. The roster is additionally super-admin only, enforced in
 * the service rather than here, because that is the layer that also knows the
 * company.
 */
export const clockRouter = Router();

clockRouter.use(requireAuth, requireUser, requireModule("clock"));

clockRouter.get("/me", validate({ query: myShiftsSchema }), async (req, res) => {
  ok(res, await getMyClock(actor(req), query<MyShiftsQuery>(req)));
});

clockRouter.post("/in", validate({ body: clockInSchema }), async (req, res) => {
  ok(res, await clockIn(actor(req), body<ClockInInput>(req)));
});

clockRouter.post("/out", validate({ body: clockOutSchema }), async (req, res) => {
  ok(res, await clockOut(actor(req), body<ClockOutInput>(req)));
});

clockRouter.post("/break", validate({ body: breakSchema }), async (req, res) => {
  ok(res, await toggleBreak(actor(req)));
});

/*
 * Your own hours, or — with ?userId — someone else's, which the service
 * restricts to a super admin. One route for both so the Playground panel and
 * the employee's own header read the same numbers by the same code.
 */
clockRouter.get("/stats", validate({ query: clockStatsSchema }), async (req, res) => {
  ok(res, await getClockStats(actor(req), query<ClockStatsQuery>(req)));
});

clockRouter.get("/roster", validate({ query: rosterSchema }), async (req, res) => {
  ok(res, await getRoster(actor(req), query<RosterQuery>(req)));
});
