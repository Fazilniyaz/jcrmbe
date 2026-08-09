import { Router } from "express";
import { created, noContent, ok, pageMeta } from "../../lib/http";
import { body, idParam, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import { mailLimiter } from "../../middleware/rateLimit";
import {
  createEmployeeSchema,
  listEmployeesSchema,
  setStatusSchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type ListEmployeesQuery,
  type UpdateEmployeeInput,
} from "./employees.schema";
import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  listEmployees,
  resendEmployeeInvite,
  setOwnStatus,
  updateEmployee,
} from "./employees.service";

export const employeesRouter = Router();

employeesRouter.use(requireAuth, requireUser);

/**
 * Anyone signed in may set their OWN availability — it is the header control,
 * not an admin action — so it sits above the module guard.
 */
employeesRouter.patch("/me/status", validate({ body: setStatusSchema }), async (req, res) => {
  const { currentStatus } = body<{ currentStatus: CreateEmployeeInput["currentStatus"] }>(req);
  ok(res, await setOwnStatus(actor(req), currentStatus));
});

employeesRouter.use(requireModule("employees"));

employeesRouter.get("/", validate({ query: listEmployeesSchema }), async (req, res) => {
  const q = query<ListEmployeesQuery>(req);
  const { rows, total } = await listEmployees(actor(req), q);
  ok(res, rows, pageMeta(total, q.page, q.perPage));
});

employeesRouter.post("/", mailLimiter, validate({ body: createEmployeeSchema }), async (req, res) => {
  const result = await createEmployee(actor(req), body<CreateEmployeeInput>(req));
  created(res, result, `/api/v1/employees/${result.employee.id}`);
});

employeesRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await getEmployee(actor(req), params<{ id: string }>(req).id));
});

employeesRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateEmployeeSchema }),
  async (req, res) => {
    ok(res, await updateEmployee(actor(req), params<{ id: string }>(req).id, body<UpdateEmployeeInput>(req)));
  },
);

employeesRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  await deleteEmployee(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});

employeesRouter.post(
  "/:id/invite/resend",
  mailLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    ok(res, await resendEmployeeInvite(actor(req), params<{ id: string }>(req).id));
  },
);
