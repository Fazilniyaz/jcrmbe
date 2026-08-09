/*
 * Seed.
 *
 * Creates nothing sensitive: no passwords, no tokens, no master account. It
 * exists so `prisma db push && npm run seed` gives you a tenant you can look at,
 * and so the indexes get exercised once before the first real write.
 *
 * The company it creates is left in `invited` state with its owner holding NO
 * password — the only way in is the normal invite flow, which is the point.
 *
 *   npm run seed            -> creates the demo company if it isn't there
 *   npm run seed -- --reset -> deletes it first
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo-owner@example.com";

async function main() {
  const reset = process.argv.includes("--reset");

  const existing = await prisma.company.findUnique({
    where: { email: DEMO_EMAIL },
    select: { id: true },
  });

  if (existing && reset) {
    const users = await prisma.user.findMany({ where: { companyId: existing.id }, select: { id: true } });
    const projects = await prisma.project.findMany({
      where: { companyId: existing.id },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.refreshToken.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }),
      prisma.notification.deleteMany({ where: { companyId: existing.id } }),
      prisma.kraEvent.deleteMany({ where: { companyId: existing.id } }),
      prisma.task.deleteMany({ where: { companyId: existing.id } }),
      prisma.projectMember.deleteMany({ where: { projectId: { in: projects.map((p) => p.id) } } }),
      prisma.project.deleteMany({ where: { companyId: existing.id } }),
      prisma.user.deleteMany({ where: { companyId: existing.id } }),
      prisma.branch.deleteMany({ where: { companyId: existing.id } }),
      prisma.company.delete({ where: { id: existing.id } }),
    ]);
    console.log("Removed the previous demo company.");
  } else if (existing) {
    console.log("Demo company already present. Pass --reset to recreate it.");
    return;
  }

  const company = await prisma.company.create({
    data: {
      companyName: "Northwind Demo Ltd",
      companyAddress: "1 Example Street, Kochi, India",
      companyWebsite: "https://example.com",
      linkedinProfile: null,
      about: "A placeholder tenant for local development. Not a real customer.",
      ownerName: "Demo Owner",
      email: DEMO_EMAIL,
      headBranch: "Kochi",
      state: "invited",
      settings: { autoEmployeeId: true, defaultBranch: null },
    },
  });

  const branch = await prisma.branch.create({
    data: { companyId: company.id, name: "Kochi", isHead: true },
  });

  await prisma.user.create({
    data: {
      companyId: company.id,
      branchId: branch.id,
      name: "Demo Owner",
      email: DEMO_EMAIL,
      empId: "JDX-001",
      roles: ["superAdmin"],
      empType: "admin",
      isOwner: true,
      // No passwordHash and no invite token: use the master portal's
      // "resend invite" to generate a real one.
      state: "invited",
    },
  });

  console.log(`Created demo company ${company.id} (state: invited, owner has no password).`);
  console.log("Sign in as master, open Companies, and use Resend invite to activate it.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
