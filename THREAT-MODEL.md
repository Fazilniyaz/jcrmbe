# Jadvix API — threat model

STRIDE over the components, DREAD on what came out of it, and the findings that
were fixed during the build. Re-run this when the trust boundaries move.

## 1. Trust boundaries

```
┌── Browser (untrusted) ───────────────────────────────────────────┐
│  Next.js app          access token in memory only                │
│                       refresh token in an httpOnly cookie        │
└──────────────┬───────────────────────────────────────────────────┘
               │  HTTPS, CORS allowlist, Bearer token
┌──────────────▼── jadvix-backend (trusted) ───────────────────────┐
│  helmet → cors → json(256kb) → rejectOperators → rateLimit       │
│  requireAuth → requireUser/requireMaster → requireModule         │
│  service layer: every query filtered by companyId FROM THE TOKEN │
└──────────────┬───────────────────────────────────────────────────┘
               │  Prisma, TLS
┌──────────────▼── MongoDB Atlas ──────────────────────────────────┐
│  argon2id hashes · SHA-256 token hashes · project vault (plain)  │
└──────────────────────────────────────────────────────────────────┘
               │
        Gmail SMTP (App Password) — invite links only
```

Three boundaries matter: browser→API (authentication), tenant→tenant (the
`companyId` filter), and role→role (the module registry and the project
acceptance flow).

## 2. STRIDE

| # | Category | Threat | Control | DREAD | Residual |
|---|----------|--------|---------|-------|----------|
| S1 | Spoofing | Forged access token | HS256 with a 32+ char secret, `algorithms` pinned so `alg:none` is rejected, issuer + audience pinned so a refresh token can't be replayed as an access token | 3.4 | Low |
| S2 | Spoofing | Stolen refresh token replayed | Token is hashed in the DB and single-use; presenting a revoked one is treated as replay and **every** session for that user is revoked | 3.0 | Low |
| S3 | Spoofing | Credential stuffing | argon2id, generic errors, 20 req/15 min per IP, DB-backed lockout after 8 failures (survives restart, shared across instances) | 4.0 | Low |
| S4 | Spoofing | Invite link guessed | 256-bit random token, only its SHA-256 stored, single-use, 72 h expiry, 10 attempts/hour | 2.6 | Low |
| T1 | Tampering | NoSQL operator injection (`{"$ne":null}` as a password) | `rejectOperators` refuses any `$`-prefixed or dotted key anywhere in body/query/params, **plus** every zod schema types scalars as scalars and is `.strict()` | 3.2 | Low |
| T2 | Tampering | Client dictates its own KRA deduction | The deduction is computed server-side from the **stored** checklist; the request only names which line ids failed | 2.8 | Low |
| T3 | Tampering | Client claims a different tenant | `companyId` is read from the verified token and re-read from the DB row; no endpoint accepts it as input | 2.4 | Low |
| T4 | Tampering | Mass assignment via extra JSON keys | Every schema is `.strict()`; unknown keys are a 422, not a silent write | 2.6 | Low |
| R1 | Repudiation | "I never failed that task" | Append-only `Task.updates` and `Task.qcReviews`, plus a `KraEvent` row per KRA move recording delta, reason and balance-after | 3.0 | Low |
| R2 | Repudiation | Admin denies deleting a tenant | `logger.warn` on company/employee/project/task deletion, disable, and module-access change, with the acting user id | 3.4 | Medium — logs are local; ship them |
| I1 | Info disclosure | Reading another tenant's data | Tenant filter on every query; by-id reads answer **404, not 403**, so an id can't be probed for existence | 4.2 | Low |
| I2 | Info disclosure | Account enumeration on login | One message for wrong password, unknown user, un-activated invite and disabled company; a dummy argon2 verify equalises the timing | 3.0 | Low |
| I3 | Info disclosure | Project vault read by the wrong person | Never in list responses; `canSeeSecrets` requires superAdmin, or a manager/team-leader with an **accepted** membership; clients and vendors always refused | 4.4 | Medium — values are stored unencrypted |
| I4 | Info disclosure | Secrets in logs | pino `redact` strips authorization, cookies, set-cookie, every `*password*`, `*token*`, `*Hash` and `secrets` path | 3.0 | Low |
| I5 | Info disclosure | Stack traces to the client | Only `ApiError` reaches the client; Prisma and unexpected errors become a bare 500 and are logged | 2.4 | Low |
| D1 | DoS | Request flood | 300 req/min global, 20/15 min on auth, 10/hour on password endpoints, 256 kb body cap, `MAX_CANDIDATES` bounds argon2 work per login | 4.0 | Medium — in-process store; use Redis when scaling |
| D2 | DoS | Lockout used to deny a real user | Lockout is time-boxed to 15 min and the IP limiter caps how fast it can be triggered | 3.8 | Accepted |
| E1 | Priv-esc | Granting yourself superAdmin | Only a superAdmin may change roles at all, and the `superAdmin` role cannot be granted through the API | 3.6 | Low |
| E2 | Priv-esc | Editing your own KRA back to 100 | **Was possible.** `assertSelfEditAllowed` now limits self-edits to name, phone, tone and availability | 5.2 → 2.0 | Fixed |
| E3 | Priv-esc | Manager appoints themselves to a project | Manager invitations are superAdmin-only; a manager can only invite plain members, and only after accepting the project themselves | 3.4 | Low |
| E4 | Priv-esc | Task pushed to someone outside the project | Assignees must have an **accepted** membership on one of the task's projects | 3.0 | Low |
| E5 | Priv-esc | Tenant locks itself out | The owner can't be disabled, deleted, or stripped of superAdmin | 2.8 | Low |
| E6 | Priv-esc | Module guard bypassed by a stale token | Roles and `moduleAccess` are re-read from the DB on **every** request, so a revocation takes effect immediately rather than at token expiry | 3.2 | Low |

## 3. Findings raised and fixed during the build

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| F1 | **High** | `nodemailer@6` carries eight advisories including SMTP command injection via CRLF and `envelope.size` (GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g) | Upgraded to `nodemailer@^9.0.4`. `npm audit --omit=dev` is now clean in both repos |
| F2 | **High** | Privilege escalation: a manager has the Employees module and passed the "can write to my own row" test, so `PATCH /employees/{ownId} {"kra":100}` erased every QC deduction against them | `assertSelfEditAllowed` — self-edits are limited to name, phone, tone, availability. `employees.service.ts` |
| F3 | Medium | Cross-tenant existence oracle: `removeMember` read the membership before proving the project belonged to the caller's company, so the error text distinguished "not a member" from "member of another tenant's project" | Tenant check moved first; both cases now answer the same 404. `projects.service.ts` |
| F4 | Medium | Lockout griefing: because an email is unique per tenant rather than globally, a failed attempt was charged to every candidate as it was tried — so eight successful logins by one tenant's user could lock out a namesake in another | Failures are only recorded once nothing matched. `auth.service.ts` |
| F5 | Low | The frontend originally held the access token where a script could read it | Kept in a module variable, never localStorage; the durable half is the httpOnly refresh cookie |

## 4. Accepted risks

- **Project vault values are stored unencrypted.** They are Mongo documents, so
  they are protected by Atlas encryption-at-rest and by the access rules in I3,
  but a database dump exposes them. This matches what the frontend already
  warned about and is fine for placeholder and non-production configuration.
  Put real production credentials in a secret manager, not here.
- **Rate-limit counters are in-process.** Behind N instances the effective limit
  is N × max. The control that actually stops credential stuffing — the account
  lockout — is in the database, so correctness never depends on the counter.
  Swap in a Redis store before scaling out.
- **No MFA.** Out of scope for this build. The account lockout and the argon2
  cost are what stand in for it today.
- **Logs are local.** R2 stays Medium until they are shipped somewhere with
  retention and alerting.

## 5. What to re-check when things change

- Any new router must mount `requireAuth` as its first middleware — the pattern
  the existing ones follow is what makes the default closed.
- Any new by-id read must filter on `companyId` **in the same query**, not after.
- Any new field on `User` must be considered against `SELF_EDITABLE` (F2).
- Any new list endpoint must not include `Project.secrets`.
