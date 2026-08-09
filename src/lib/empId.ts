import { nextEmployeeId } from "./codes";
import { prisma } from "./prisma";
import { ApiError } from "./errors";

/*
 * Employee badge numbers.
 *
 * `empId` is globally unique in the schema, not per-company, so the series is
 * allocated across the whole platform. Two companies creating an employee at the
 * same instant can both compute the same next number, so the write is retried
 * against the unique index rather than guarded by a lock — the index is the
 * source of truth and the loop is what makes the race harmless.
 */

const MAX_ATTEMPTS = 12;

export async function allocateEmpId(): Promise<string> {
  const recent = await prisma.user.findMany({
    where: { empId: { startsWith: "JDX-" } },
    select: { empId: true },
    orderBy: { empId: "desc" },
    take: 50,
  });
  return nextEmployeeId(recent.map((u) => u.empId));
}

/**
 * Run `write` with a freshly allocated empId, retrying on a unique-constraint
 * collision. The callback receives the id to use.
 */
export async function withEmpId<T>(
  preferred: string | undefined,
  write: (empId: string) => Promise<T>,
): Promise<T> {
  if (preferred) {
    // An explicitly chosen id is not auto-incremented — a collision is the
    // caller's mistake and should be reported, not silently changed.
    return write(preferred);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const empId = await allocateEmpId();
    try {
      return await write(empId);
    } catch (err) {
      if (!isEmpIdCollision(err)) throw err;
      lastError = err;
    }
  }
  throw ApiError.conflict("Could not allocate an employee ID. Try again.", { cause: String(lastError) });
}

function isEmpIdCollision(err: unknown): boolean {
  const known = err as { code?: string; meta?: { target?: unknown } };
  if (known?.code !== "P2002") return false;
  const target = known.meta?.target;
  return Array.isArray(target) ? target.includes("empId") : String(target ?? "").includes("empId");
}
