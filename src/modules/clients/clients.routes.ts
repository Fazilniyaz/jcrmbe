import { Router } from "express";
import { created, noContent, ok, pageMeta } from "../../lib/http";
import { body, idParam, params, query, validate } from "../../middleware/validate";
import { actor, requireAuth, requireModule, requireUser } from "../../middleware/auth";
import {
  createClientSchema,
  listClientsSchema,
  updateClientSchema,
  type CreateClientInput,
  type ListClientsQuery,
  type UpdateClientInput,
} from "./clients.schema";
import {
  createClient,
  deleteClient,
  getClient,
  listClients,
  updateClient,
} from "./clients.service";

export const clientsRouter = Router();

clientsRouter.use(requireAuth, requireUser, requireModule("clients"));

clientsRouter.get("/", validate({ query: listClientsSchema }), async (req, res) => {
  const q = query<ListClientsQuery>(req);
  const { rows, total } = await listClients(actor(req), q);
  ok(res, rows, pageMeta(total, q.page, q.perPage));
});

clientsRouter.post("/", validate({ body: createClientSchema }), async (req, res) => {
  const client = await createClient(actor(req), body<CreateClientInput>(req));
  created(res, client, `/api/v1/clients/${client.id}`);
});

clientsRouter.get("/:id", validate({ params: idParam }), async (req, res) => {
  ok(res, await getClient(actor(req), params<{ id: string }>(req).id));
});

clientsRouter.patch(
  "/:id",
  validate({ params: idParam, body: updateClientSchema }),
  async (req, res) => {
    ok(res, await updateClient(actor(req), params<{ id: string }>(req).id, body<UpdateClientInput>(req)));
  },
);

clientsRouter.delete("/:id", validate({ params: idParam }), async (req, res) => {
  await deleteClient(actor(req), params<{ id: string }>(req).id);
  noContent(res);
});
