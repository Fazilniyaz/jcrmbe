# jadvix-backend

Multi-tenant CRM API for Jadvix. Node + Express 5 + TypeScript, Prisma against
MongoDB Atlas, zod for validation, argon2 for passwords, JWT for sessions,
nodemailer for invitations, pino for logs.

Stateless: the access token is self-contained and the refresh token is a row, so
any instance can serve any request and a restart signs nobody out.

---

## Running it

### 1. Configure

```bash
cd jadvix-backend
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | What to put there |
|---|---|
| `DATABASE_URL` | Your Atlas SRV string, including a database name |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Two **different** random strings, 32+ chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `MASTER_PASSWORD_HASH` | Run `npm run hash-master` and paste the line it prints |
| `GMAIL_APP_PASSWORD` | Your 16-character Gmail App Password (Google Account → Security → 2-Step Verification → App passwords). Leave empty and invite links are logged instead of emailed |

The process refuses to start on a missing or malformed value rather than
failing on the first request.

### 2. Create the master credential

```bash
npm run hash-master
# prompts, input hidden, prints:  MASTER_PASSWORD_HASH=$argon2id$...
```

The password itself is never written anywhere. Paste the printed line into
`.env`.

### 3. Push the schema

```bash
npm run prisma:push     # creates collections and indexes
npm run seed            # optional: one demo tenant, no credentials in it
```

### 4. Start

```bash
npm run dev             # tsx watch, pretty logs
# or
npm run build && npm start
```

`GET http://localhost:4000/health` should answer `{"data":{"status":"ok",...}}`.

### 5. Start the frontend

```bash
cd ../jadvixCRMWebApp
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
npm run dev
```

Open http://localhost:3000/login.

### First run, end to end

1. Sign in on the **Master** tab with `MASTER_EMAIL` and the password you hashed.
2. Companies → **New company**. Fill the eight fields and create.
3. The owner gets an email with a link to `/invite/accept?token=…`. With
   `GMAIL_APP_PASSWORD` empty the link is shown in the UI and written to the log
   instead.
4. Open the link, set a password. The owner and the company both go `active`.
5. Sign in on the **Company account** tab as that owner — they are the tenant's
   superAdmin with every module.

---

## API

Everything is under `/api/v1`. Success is `{ data }` (plus `{ meta }` on lists);
failure is `{ error: { code, message, details? } }`.

Only `auth` and `invite` are reachable without a token.

| Method | Path | Who |
|---|---|---|
| POST | `/auth/master/login` | public |
| POST | `/auth/login` | public |
| POST | `/auth/refresh` · `/auth/logout` | cookie |
| GET | `/auth/me` | any token |
| GET | `/invite/validate?token=` | public |
| POST | `/invite/accept` | public |
| GET | `/master/dashboard` | master |
| GET POST | `/companies` | master |
| GET PATCH DELETE | `/companies/:id` | master |
| POST | `/companies/:id/invite/resend` | master |
| GET | `/reference/countries` | any user |
| GET POST | `/clients` | Clients module |
| GET PATCH DELETE | `/clients/:id` | Clients module |
| GET | `/branches` | Branches module |
| POST | `/branches` | superAdmin |
| PATCH DELETE | `/branches/:id` | superAdmin |
| PUT | `/branches/default` | superAdmin |
| GET POST | `/employees` | Employees module |
| GET PATCH DELETE | `/employees/:id` | Employees module |
| PATCH | `/employees/me/status` | any user |
| POST | `/employees/:id/invite/resend` | Employees module |
| GET POST | `/projects` | Projects module |
| GET PATCH DELETE | `/projects/:id` | Projects module |
| GET | `/projects/invitations` | Projects module |
| POST | `/projects/:id/managers` | superAdmin |
| POST | `/projects/:id/members` | accepted manager |
| POST | `/projects/:id/membership` | the invitee |
| DELETE | `/projects/:id/members/:userId` | manager / superAdmin |
| PUT | `/projects/:id/plan` | accepted manager |
| GET PUT | `/projects/:id/secrets` | project leads only |
| GET POST | `/tasks` | Tasks module |
| GET PATCH DELETE | `/tasks/:id` | Tasks module |
| PATCH | `/tasks/:id/state` · `/tasks/:id/assignees` | manager or assignee |
| PATCH | `/tasks/:id/checklist/:itemId` | manager or assignee |
| POST | `/tasks/:id/qc-review` | QC or manager |
| GET PATCH | `/settings/profile` | any user |
| POST | `/settings/password` | any user |
| GET | `/settings/modules` | any user |
| GET | `/settings/module-access` | superAdmin |
| PUT | `/settings/module-access/:userId` | superAdmin |
| GET PATCH | `/settings/workspace` | read: any · write: superAdmin |
| GET | `/notifications` | any user |
| PATCH | `/notifications/:id/read` · `/notifications/read-all` | any user |
| DELETE | `/notifications` | any user |

---

## Business rules enforced

Server-side, in the service layer. The client cannot opt out of any of them.

### Tenancy

1. Every query filters on `companyId` taken from the **verified token**. No
   endpoint accepts a tenant id as input.
2. A by-id fetch for something outside your company answers **404, not 403** —
   a 403 would confirm the record exists.
3. Roles and module grants are re-read from the database on every request, so
   disabling an account or revoking a module takes effect immediately.
4. Disabling a company revokes every refresh token belonging to it.

### Companies (master only)

5. Creating a company writes the company, its head branch, and an owner user
   (`isOwner`, `roles:[superAdmin]`, no password) in one transaction.
6. Company and owner both start `invited`. Setting the password via the invite
   is what flips **both** to `active`.
7. The owner's email is fixed after creation — it identifies the account.
8. Deleting a company requires typing its name back, and clears every user,
   project, task, membership, notification, KRA event and token in it.

### Invitations

9. The token is 256 bits of randomness. Only its SHA-256 is stored.
10. Single-use: the hash is cleared in the same update that sets the password,
    so a replay updates zero rows.
11. Expires in 72 hours. Every failure mode — unknown, expired, already used,
    company disabled — returns one identical message.
12. Accepting revokes all existing sessions for that user.

### Branches and the default-branch scope

B0. A branch has a **name, a city, a country and a currency**. The currency is
    **derived from the country by `lib/countries.ts` on every write and is never
    accepted from the client** — the create/update schemas are `.strict()`, so
    sending one is a 422 rather than an override. A request cannot pair India
    with dollars and silently mis-state every figure reported against the
    branch. `GET /reference/countries` serves the one country→currency table
    both dropdowns render from, so the two copies cannot drift.
B1. A company is created with exactly one branch — the `headBranch` name plus
    the city and country from the Create Company form — flagged `isHead`.
    Editing the company carries those edits through to the head Branch row, so
    Companies and Branches can never disagree about where the office is.
B2. **The head branch is the standing default.** Until someone pins another,
    every module is scoped to it. With one office that is indistinguishable
    from showing everything, so it costs nothing until a second one exists.
B3. Three states in one nullable column: `null` → the head branch (nobody has
    chosen), a name → that branch, `"*"` → no scope at all. `"*"` is rejected
    as a branch name, so it can never collide with a real one.
B4. `GET /settings/workspace` and `GET /branches` both report the **effective**
    branch, not the raw column — nothing downstream has to re-derive it.
B5. Pinning a branch narrows employees, projects, tasks, leave and attendance
    together, for the whole workspace rather than for the person who set it.
B6. A project belongs to a branch if anyone accepted onto it works there — so a
    shared project stays visible to a manager in either office.
B7. Only a superAdmin can add, rename, delete a branch, or change the default.
B8. The head office cannot be deleted, only renamed; renaming it also updates
    the company's `headBranch`.
B9. A branch with people still in it cannot be deleted — the response says how
    many, so they can be moved first.
B10. Renaming the pinned branch carries the scope with it, and deleting the
    pinned branch falls back to the head office. Neither leaves a dangling name
    behind that would silently empty every module.
B11. An employee created without a branch is placed in the head office.
    Leaving them unassigned would make them vanish the moment a scope applied.
B12. `GET /branches` reports how many people are still unassigned, so the
    condition in B11 is visible rather than discovered.
B13. Changing a branch's country moves its currency with it — they are written
    together, never separately.
B14. The workspace reports the currency of the branch **in force**, and money is
    formatted in it. Scoped to all branches the currency is null, because a
    group spanning three of them has no single one to report in and picking the
    head office's would mis-state the other two.

### Employees

13. `empId` auto-generates as `JDX-001…` from the highest in use (max, not
    count, so deletion never reissues a code) and stays editable.
14. Creating an employee sends the same invite → set-password flow. They cannot
    sign in until they have set one.
15. Only a superAdmin changes roles, and **nobody** can grant `superAdmin`.
16. A manager may only create and edit their own direct reports; a created
    employee is forced to report to them regardless of what the form said.
17. You may edit your own record's name, phone, avatar colour and availability
    — nothing else. Not your KRA, not your state, not your employee id.
18. The account owner cannot be disabled, deleted, or stripped of superAdmin.
19. Deleting someone pulls them off every project and task; the work survives,
    and a task whose primary assignee was deleted re-points at the next one.
20. `acceptedProjects` and `assignedTasks` are computed on read, never stored.

### Projects — the acceptance flow

20a. **The company owner is never a team member.** They already reach every
    project as superAdmin, so adding them would misreport the team size and put
    them in the assigned-employees list of work they aren't doing. They can
    still be a project *manager*, which is a different thing.
20b. A new employee is placed in the branch **currently in force**, not the head
    office. Filing them under the head office while an admin worked in a pinned
    hub is what made a newly added person appear not to exist.
20c. `Requests` is a baseline module nobody can be denied, and
    `GET /projects/invitations` plus `POST /projects/:id/membership` sit behind
    it rather than behind Projects — someone in sales has no Projects module but
    can still be invited to one, and gating their own invitation behind Projects
    would leave it permanently unanswerable.
21. A superAdmin creates the project and invites a manager or team leader:
    `ProjectMember{ role:manager, state:invited }`.
22. **Only a superAdmin can appoint a project manager.** A manager cannot
    appoint a peer.
23. The manager must **accept** before they can change anything. An invited
    manager can see the project but `assertCanManage` refuses every write.
24. Only an **accepted** manager can add team members, each `state:invited`.
25. Each employee must accept before they are on the team.
26. Only the invitee answers their own invitation.
27. Visibility, enforced in every list and get:
    - employee → only projects with an **accepted** membership
    - manager / team leader → projects where they have **any** membership
      (they must see an invitation to accept it)
    - superAdmin → everything in the company
28. Progress is the mean of the project's task scores, computed on read — so
    ticking a checklist line moves the project bar.
29. The vault is never in a list response, and requires superAdmin or an
    **accepted** manager/team-leader. Clients and vendors are always refused.
30. Deleting a project detaches its tasks; tasks left with no project at all
    are removed rather than orphaned.

### Tasks

31. Tasks are **not** accepted or declined — accepting the project is the
    obligation.
32. A task can only be created by a superAdmin or an accepted project manager.
33. A task can only be assigned to someone with an **accepted** membership on
    one of its projects.
34. Two rights, deliberately separate: changing *what the work is* (retitle,
    re-scope, reassign, delete) needs manager rights; *doing the work* (move
    state, score the checklist) is open to assignees.
35. `projectId === projectIds[0]` and `assigneeId === assigneeIds[0]` are
    maintained by the service, so the canonical single-valued schema and the
    frontend's multi-valued model never disagree.
36. `openWork` is recomputed from the tasks after anything that could change it,
    never incremented.

### KRA — the frontend's rule, unchanged

37. KRA moves on a **QC verdict**, which is what the existing Checklist module
    does. The spec's "deduct on failed/overdue" default was not used, because a
    rule was already defined in the frontend.
38. Only an **Error** verdict costs anything. *Corrections* sends the task back
    with no deduction. *Approved* signs it off.
39. The cost is the sum of the `points` on the flagged checklist lines,
    computed from the **stored** checklist — the client sends line ids, never a
    number.
40. **Every assignee takes the full deduction.** It is not split: two people on
    a task worth 4 points lose 4 each.
41. KRA is clamped to 0–100 and can never go negative.
42. A rejected verdict returns the task to In Progress and resets the flagged
    lines to zero, so there is something concrete to redo.
43. The task update, every KRA move and every `KraEvent` are one transaction —
    points are never deducted without a record of why.
44. `kraApplied` guards against double-charging. Marking a task `failed`
    deducts its own `kraPoints` once, and only if QC has not already charged it.

### Settings and module access

45. Every portal's Settings can read its own profile, change its own password,
    and sign out.
46. Changing a password verifies the current one first — a stolen access token
    is not enough to lock the real owner out — and revokes every other session.
47. Only extra grants are stored in `moduleAccess`; role defaults are computed,
    so a role change brings the right baseline instead of leaving a stale grant.
48. A superAdmin always has every module and their row in the grid is read-only.
49. The master portal has exactly three modules: Dashboard, Companies, Settings.
50. An unknown module slug is dropped, never stored.

### Passwords

51. argon2id, 19 MiB / 2 passes / 1 lane.
52. Minimum 12 characters, upper + lower + number + symbol, no common words, no
    4-character sequences (`1234`, `abcd`), no 4-character repeats.
53. Eight failed logins locks an account for 15 minutes. The counter is in the
    database, so it survives a restart and is shared across instances.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | tsx watch |
| `npm run build` | `prisma generate` + `tsc` |
| `npm start` | run the build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:push` | push the schema to Atlas |
| `npm run seed` | one demo tenant (`--reset` to recreate) |
| `npm run hash-master` | print an argon2 hash for `MASTER_PASSWORD_HASH` |

## Security

See [THREAT-MODEL.md](./THREAT-MODEL.md) for the STRIDE table, the findings
raised and fixed during the build, and the accepted risks.
