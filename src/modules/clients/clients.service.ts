import type { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { nextCode } from "../../lib/codes";
import { isLead, isSuperAdmin, type UserAuth } from "../../middleware/auth";
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from "./clients.schema";

/*
 * Clients — the accounts a company delivers for.
 *
 * A project points at one by id, which is what lets the project form offer a
 * real list instead of a free-text name. Tenant-scoped like everything else:
 * companyId comes from the token and is on every query.
 */

const CLIENT_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  contact: true,
  email: true,
  phone: true,
  industry: true,
  value: true,
  since: true,
  status: true,
  notes: true,
  tone: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClientSelect;

/** Sales owns the client list; leads and admins can also maintain it. */
function assertCanWrite(auth: UserAuth) {
  if (isSuperAdmin(auth) || isLead(auth) || auth.roles.includes("sales")) return;
  throw ApiError.forbidden("Only sales, a manager or an admin can change the client list.");
}

async function nextClientCode(companyId: string): Promise<string> {
  const existing = await prisma.client.findMany({
    where: { companyId },
    select: { code: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return nextCode(existing.map((c) => c.code), "CL", 2);
}

export async function listClients(auth: UserAuth, query: ListClientsQuery) {
  const where: Prisma.ClientWhereInput = {
    companyId: auth.companyId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { contact: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
            { code: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      select: CLIENT_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
    prisma.client.count({ where }),
  ]);

  // How many projects each account has — the number the list actually needs,
  // and the reason a client can't be deleted out from under live work.
  const projects = await prisma.project.findMany({
    where: { companyId: auth.companyId, clientId: { not: null } },
    select: { clientId: true },
  });
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (p.clientId) counts.set(p.clientId, (counts.get(p.clientId) ?? 0) + 1);
  }

  return {
    rows: rows.map((c) => ({ ...c, projectCount: counts.get(c.id) ?? 0 })),
    total,
  };
}

export async function getClient(auth: UserAuth, id: string) {
  const client = await prisma.client.findFirst({
    where: { id, companyId: auth.companyId },
    select: CLIENT_SELECT,
  });
  if (!client) throw ApiError.notFound("No such client.");

  const projects = await prisma.project.findMany({
    where: { companyId: auth.companyId, clientId: id },
    select: { id: true, name: true, code: true, state: true, dueDate: true },
    orderBy: { createdAt: "desc" },
  });

  return { ...client, projects, projectCount: projects.length };
}

export async function createClient(auth: UserAuth, input: CreateClientInput) {
  assertCanWrite(auth);

  const duplicate = await prisma.client.findFirst({
    where: { companyId: auth.companyId, name: { equals: input.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (duplicate) throw ApiError.conflict("This company already has a client with that name.");

  const client = await prisma.client.create({
    data: {
      companyId: auth.companyId,
      code: input.code ?? (await nextClientCode(auth.companyId)),
      name: input.name,
      contact: input.contact,
      email: input.email,
      phone: input.phone ?? null,
      industry: input.industry ?? null,
      value: input.value,
      since: input.since ?? String(new Date().getFullYear()),
      status: input.status,
      notes: input.notes ?? null,
      tone: input.tone,
    },
    select: CLIENT_SELECT,
  });

  logger.info({ clientId: client.id, companyId: auth.companyId, by: auth.userId }, "client created");
  return { ...client, projectCount: 0 };
}

export async function updateClient(auth: UserAuth, id: string, input: UpdateClientInput) {
  assertCanWrite(auth);

  const existing = await prisma.client.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true, name: true },
  });
  if (!existing) throw ApiError.notFound("No such client.");

  const client = await prisma.client.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
      ...(input.industry !== undefined ? { industry: input.industry ?? null } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.since !== undefined ? { since: input.since ?? null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.code !== undefined ? { code: input.code ?? existing.name } : {}),
    },
    select: CLIENT_SELECT,
  });

  // Projects carry the client's display name alongside the id so a project row
  // stays readable without a join. A rename has to carry through, or the two
  // disagree.
  if (input.name && input.name !== existing.name) {
    await prisma.project.updateMany({
      where: { companyId: auth.companyId, clientId: id },
      data: { client: input.name },
    });
  }

  return client;
}

/**
 * Remove a client. Projects survive and simply lose the account link, which is
 * what the frontend's `deleteClient` did — the work was still delivered.
 */
export async function deleteClient(auth: UserAuth, id: string) {
  assertCanWrite(auth);

  const client = await prisma.client.findFirst({
    where: { id, companyId: auth.companyId },
    select: { id: true, name: true },
  });
  if (!client) throw ApiError.notFound("No such client.");

  await prisma.$transaction([
    prisma.project.updateMany({
      where: { companyId: auth.companyId, clientId: id },
      data: { clientId: null },
    }),
    prisma.client.delete({ where: { id } }),
  ]);

  logger.warn({ clientId: id, by: auth.userId }, "client deleted");
}
