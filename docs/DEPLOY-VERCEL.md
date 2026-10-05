# Deploying the Jadvix API to Vercel

Both services on Vercel:

| Piece | Repo | Vercel project |
|---|---|---|
| Web app | `jcrm` | e.g. `jadvix-app` |
| API | `jcrmbe` | e.g. `jadvix-api` |
| Database | — | MongoDB Atlas (**must be a replica set**) |

Everything the API needs to run serverless is already in the repo:
`api/index.ts` (the entry), `vercel.json` (routing and build), `.vercelignore`.

---

## Read this before you start

Four things behave differently on Vercel. None of them stop it working; all of
them will confuse you later if you meet them without warning.

**1. There is no "restart".** A serverless function has no process to restart.
See [Restarting](#restarting-and-redeploying) at the bottom — the short version
is that changing an environment variable does nothing until you **redeploy**.

**2. File uploads must go to ImageKit.** The filesystem is read-only apart from
`/tmp`, and `/tmp` is gone when the instance is recycled. Without
`IMAGEKIT_*` set, attachments are written somewhere nobody can read them back
from. The API logs an error on every cold start when the keys are missing — if
you see it in the function logs, that is why.

**3. Request bodies are capped at ~4.5 MB** by the platform, below the app's own
`UPLOAD_MAX_BYTES`. A bigger attachment is rejected at the edge before any of
our code runs, so the error will not look like one of ours.

**4. HTTP rate limiting becomes decorative.** `express-rate-limit` keeps its
counters in process memory, and Vercel runs many short-lived instances, so the
effective limit is (instances × max) and resets whenever one is recycled. The
defence that actually stops credential stuffing is the database lockout
(`User.failedLoginCount` / `lockedUntil`, 8 attempts → 15 minutes), which is
unaffected. If you want the HTTP limit to mean something, put a Redis store
behind `make()` in `src/middleware/rateLimit.ts`.

---

## 1. Database — MongoDB Atlas

1. Create a cluster. **It must be a replica set** — `prisma.$transaction` is
   used in the company, project, team and sprint services, and a standalone
   `mongod` rejects transactions outright. Atlas clusters are replica sets by
   default.
2. Network Access → **Allow access from anywhere (`0.0.0.0/0`)**. This is not
   laziness: Vercel functions have no fixed egress IPs on Hobby/Pro, so there
   is no narrower rule you could write. The database is still protected by its
   credentials; use a long generated password.
3. Connection string, with the database named:
   ```
   mongodb+srv://USER:PASS@cluster.mongodb.net/jadvix?retryWrites=true&w=majority
   ```

---

## 2. Decide your domains first

This matters more than it looks, because of one cookie.

The refresh token lives in an `httpOnly` cookie with `SameSite=Lax`. Lax means
"only sent same-site". `vercel.app` is on the Public Suffix List, so
`jadvix-app.vercel.app` and `jadvix-api.vercel.app` are **cross-site** — the
cookie is never sent to the API, and every session dies silently at the first
token refresh. You get a login that works, then logs you out, with nothing in
any log to explain it.

**Option A — one domain, two subdomains (recommended).**

```
app.yourdomain.com   →  jadvix-app
api.yourdomain.com   →  jadvix-api
```

Same registrable domain, so they are same-site, `SameSite=Lax` works, and you
keep the CSRF protection it buys. Leave `COOKIE_SAMESITE` unset.

**Option B — the free `*.vercel.app` hostnames.**

Set `COOKIE_SAMESITE=none` on the API. The cookie is then sent cross-site, and
`Secure` is turned on automatically (a browser silently drops `SameSite=None`
without it). You lose SameSite as a CSRF defence for the refresh endpoint.
Fine for testing; move to Option A before real use.

---

## 3. Deploy the API

1. **vercel.com/new → import `jcrmbe`.**
2. **Framework Preset: Other.** Leave Build and Output on their defaults —
   `vercel.json` already sets the build command to `npx prisma generate`, which
   is what writes the Prisma client the function imports. No `tsc` step: Vercel
   compiles `api/index.ts` itself.
3. **Environment variables** — set every one of these for **Production,
   Preview and Development**:

| Key | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `DATABASE_URL` | your Atlas string | |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | |
| `JWT_REFRESH_SECRET` | a **different** `openssl rand -base64 48` | Reusing one means a refresh token is accepted as an access token. |
| `MASTER_EMAIL` | your master login email | See §5. |
| `MASTER_PASSWORD_HASH` | output of `npm run hash-master` | Never the plain password. |
| `APP_URL` | `https://app.yourdomain.com` | Invite links are built from this. |
| `API_URL` | `https://api.yourdomain.com` | |
| `CORS_ORIGIN` | `https://app.yourdomain.com` | **No trailing slash** — compared to the browser's `Origin` header verbatim. Comma-separate for several. |
| `TRUST_PROXY` | `1` | Vercel is a proxy; without this every request looks like one IP. |
| `COOKIE_SAMESITE` | `none` | **Only for Option B.** Omit on Option A. |
| `IMAGEKIT_PUBLIC_KEY` | from imagekit.io | Not optional here — see limit 2. |
| `IMAGEKIT_PRIVATE_KEY` | from imagekit.io | |
| `IMAGEKIT_URL_ENDPOINT` | `https://ik.imagekit.io/yourid` | |
| `GMAIL_USER` | your Gmail address | Optional. Without it invites are logged, not sent — and the invite URL comes back in the API response instead, which is how §6 works without mail. |
| `GMAIL_APP_PASSWORD` | a Google **App Password** | Not your account password. |
| `MAIL_FROM` | `Jadvix <you@gmail.com>` | |

4. **Deploy.**
5. **Push the schema, once.** From your machine, with `DATABASE_URL` pointing at
   the same Atlas cluster:
   ```
   npx prisma db push
   ```
   This creates every collection and index, including the new `Sprint` and
   `Shift` ones. **MongoDB has no migration files — re-run this after any
   schema change.** Vercel will not do it for you.
6. Check it: `curl https://api.yourdomain.com/health` → `{"data":{"status":"ok",...}}`

---

## 4. Deploy the web app

1. **vercel.com/new → import `jcrm`.** Framework preset: Next.js, defaults fine.
2. One environment variable:

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com/api/v1` |

   Note the `/api/v1`. It is `NEXT_PUBLIC_`, so it is **baked in at build
   time** — changing it later needs a redeploy, not just a restart.
3. Deploy, then go back to the API project and make sure `CORS_ORIGIN` names
   the real app domain. Redeploy the API after changing it (see the last
   section — the change does nothing until you do).

### Preview deployments

Every preview gets its own hostname and the API will reject it on CORS. Either
add the preview domain to `CORS_ORIGIN`, or point previews at a staging API.

---

## 5. Creating the master portal credentials

The master portal is the platform owner's login — the one account that is not
inside any company. It creates and disables companies, and nothing else: it has
exactly three modules (Dashboard, Companies, Settings) and cannot read any
company's data.

It is **not a database row.** It is two environment variables, which is why
nobody can create one through the UI and why there is exactly one.

**Step 1 — generate the hash.** In the `jcrmbe` folder on your own machine:

```bash
npm run hash-master
```

It prompts for a password with the echo suppressed and prints:

```
MASTER_PASSWORD_HASH=$argon2id$v=19$m=65536,t=3,p=4$...
```

The password itself is never written to disk, and only the hash is printed. If
you would rather not be prompted:

```bash
npm run hash-master -- 'YourPassword!23'
```

— but that lands in your shell history, so prefer the prompt.

The password must pass the same policy as everyone else's: at least 12
characters, with a lowercase letter, an uppercase letter, a number and a symbol;
no runs like `1234` or `abcd`, no character repeated four or more times, and
nothing on the common-password list. The script tells you exactly which rule
you missed and refuses to hash a weak one.

**Step 2 — set two variables** in the API's Vercel project:

```
MASTER_EMAIL=you@yourdomain.com
MASTER_PASSWORD_HASH=$argon2id$v=19$m=65536,t=3,p=4$...
```

Paste the hash exactly, including the `$` signs. Vercel's dashboard takes it
literally; if you ever set it through `vercel env` in a shell, single-quote it
so the shell does not eat the `$`.

**Step 3 — redeploy.** Environment variables are read at cold start; the
existing deployment will not pick them up (see the last section).

**Step 4 — sign in** at `https://app.yourdomain.com/login`, master portal
option, with `MASTER_EMAIL` and the password you chose.

If `MASTER_PASSWORD_HASH` is empty the master login is **disabled** rather than
open — the API logs `master login is disabled` on cold start and refuses every
attempt.

To change the password later: run `hash-master` again, replace the variable,
redeploy. There is no "forgot password" for this account by design.

---

## 6. Creating a super admin (a company's own portal)

A super admin is a company's owner. Unlike the master, this *is* a real user
row — and it is created **only** by the master portal creating a company. There
is no sign-up page, and the first super admin cannot be made from inside the
app, because there is no company for them to be inside yet.

**What one "Create Company" actually does,** in a single transaction:

1. the `Company` row, state `invited`;
2. its head `Branch`, marked `isHead`, with the currency looked up from the
   country (never taken from the form);
3. the owner `User` — `roles: ["superAdmin"]`, `empType: "admin"`,
   `isOwner: true`, state `invited`, **no password** — plus a one-time invite
   token, hashed in the database and valid for **3 days**.

**The steps:**

1. Sign in to the **master portal**.
2. **Companies → Create Company.** Fill in the company name, address, website,
   about, the **owner's name**, the **owner's email** (this becomes their login
   — one company per email address), and the head branch name, city and country.
3. Submit. The owner gets an invitation email with a link to
   `/invite/accept?token=…`.
4. **The owner opens that link and sets their password.** That is the moment
   the user goes `invited` → `active` and the company goes `invited` → `active`.
   Until then nobody can sign in to it.
5. They sign in at `/login` and land on their own super-admin portal, holding
   every module.

**If email is not configured** (no `GMAIL_APP_PASSWORD`), the API returns the
invite URL in the create-company response instead of mailing it — look at
`invite.url` in the response, or the function logs, and send it yourself. With
SMTP working the token never leaves the server, so you will not find it in a
log; that is deliberate.

**If the invite expires**, the master portal's company row has a **Resend
invite** action. It issues a fresh token and invalidates the old one. It refuses
once the owner has set a password, because then there is nothing to accept.

**After that first super admin exists**, they add everyone else from inside
their own portal — Employees → Add Employee, which sends the same kind of
invite — and decide per person which modules they get and at which level
(view or edit) in Settings → Module Access. A super admin's own row is locked
there: they always have everything, so that nobody can lock the owner out of
their own company.

---

## Restarting and redeploying

**There is nothing to restart.** This is the single biggest difference from a
normal server, and it trips everyone up once.

On Render or a VPS there is a long-lived Node process: you restart it, it
re-reads the environment, and you are done. On Vercel there is no process
between requests. Each request is served by a short-lived instance created from
the **immutable build artefact of a particular deployment**. The environment
variables are baked into that deployment when it is built. So:

> **Changing an environment variable does nothing until you redeploy.**
> No error, no warning — the old value simply keeps being used until the next
> deployment replaces the artefact.

### After a code change

Push to the branch connected to the project:

```bash
git add -A
git commit -m "..."
git push origin main
```

Vercel builds and promotes it automatically. Nothing else to do.

### After an environment-variable change

The variable is saved immediately and used by **nothing**. You must redeploy:

**Dashboard —** Project → Deployments → the top deployment → `⋯` → **Redeploy**.
**Uncheck "Use existing Build Cache"** when you changed `DATABASE_URL` or
anything Prisma reads, so `prisma generate` runs against the real value.

**CLI —**
```bash
npm i -g vercel
vercel --prod            # from the repo root; builds and promotes
```

**Git —** an empty commit is enough to trigger a build:
```bash
git commit --allow-empty -m "redeploy: pick up new env vars"
git push origin main
```

### After a schema change

Redeploying does **not** touch MongoDB. Run the push yourself, against the same
cluster, then redeploy so the regenerated Prisma client matches:

```bash
npx prisma db push
```

### "It still has the old behaviour"

In order of likelihood:

1. You changed an env var and did not redeploy. **This is almost always it.**
2. You changed `NEXT_PUBLIC_API_URL` on the web app — it is inlined at build
   time, so it needs a rebuild, not just a redeploy of the same artefact.
3. You redeployed **with** the build cache after a Prisma schema change, so the
   stale generated client was reused. Redeploy with the cache unchecked.
4. You set the variable for Preview but not Production (or the reverse). Vercel
   scopes them per environment and shows which; check all three are ticked.

### Watching it run

```bash
vercel logs <deployment-url>
```
or Project → Deployments → a deployment → **Functions** → `api/index`. The two
cold-start warnings (missing ImageKit keys, missing master hash) show up here,
and they are the fastest way to confirm which variables actually reached the
running function.

---

## Smoke test

1. `GET https://api.yourdomain.com/health` → `200`.
2. `GET https://api.yourdomain.com/api/v1/employees` with no token → `401`
   (proves the router is mounted and guarded, not that it is broken).
3. Sign in to the master portal; create a company; accept the invite; sign in
   as that super admin.
4. **Leave the tab open past the access-token lifetime** (default 15 minutes)
   and then click something. If you get logged out, the refresh cookie is not
   reaching the API — re-read §2 and set `COOKIE_SAMESITE=none`, or move both
   services onto subdomains of one domain.
5. Open **Clock** as the super admin — both tabs should list the roster.
6. Open **Tasks → sprint board** (fifth view icon), create a sprint, drag a task
   into it, reload. The card should still be in the lane.
7. Attach a file to a task, then redeploy, then download it. If it 404s, your
   ImageKit keys are not set and it went to a disk that no longer exists.
