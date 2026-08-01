# ScopeCash AI — Adversarial Audit

**Date:** 2026-07-31 · **Commit:** `ae69ca7` · **Auditor stance:** adversarial (assume broken until proven otherwise)

Every finding is marked **VERIFIED** (code path read end to end, usually executed) or
**SUSPECTED** (pattern-matched, not traced). Clearances cite the enforcing code.

---

## Phase 0 — Facts established before auditing

### What this application is

ScopeCash AI is a **multi-tenant B2B SaaS for small specialty contractors**. A contractor
uploads their original contract/estimate plus jobsite evidence (photos, audio, receipts,
messages). AI agents extract a *scope baseline* from the contract, analyze the evidence,
and identify work performed that was **not** in the original scope. The output is a
source-linked **evidence packet** used to justify a change order or an unbilled-work
invoice to the property owner or general contractor.

**Users:** contractor org members in six roles — `owner`, `admin`, `project_manager`,
`estimator`, `field_user`, `viewer` (`server/lib/roles.js`), plus a separate
platform-operator role (`User.role === 'admin'`).

**Data held:** signed construction contracts, rate sheets (unit labor/material pricing —
a contractor's most competitively sensitive asset), geotagged jobsite photos
(`EvidenceItem.gpsLat/gpsLng`, `schema.prisma:1357`), customer names and addresses, and a
six-stage money ledger (`identified → validated → submitted → approved → invoiced →
collected`).

**Worst realistic incident:** a contractor's rate sheet and contract set leaking to a
competitor or to the general contractor they are in dispute with. Second-worst: the
pricing engine producing a wrong number on a packet that gets submitted as a formal
change-order claim — a document with legal and financial weight.

**The name implies money, and it is correct to read it that way.** This platform
calculates billed amounts, tracks a six-stage revenue funnel, and charges ScopeCash's own
success fee as a percentage of what the contractor collects. **Money-touching paths were
prioritized above everything else in this audit, and that is where the most severe
findings are.**

### Phase 0 answers

| # | Question | Answer |
|---|---|---|
| 1 | **Stack** | Node ≥20.19, Express **5.2.1**, Prisma **7.7**, React dashboard. Zod validation, BullMQ jobs, JWT auth. `server/package.json` |
| 2 | **Entry point** | `server/index.js` — framework default `app.listen()`, no custom server. Async bootstrap for Cloud SQL IAM (`:300-320`). Nothing bypasses middleware. Separate `worker.js` for jobs. |
| 3 | **Route surface** | **221 source-level `router.<verb>` declarations across 39 files**, expanding to **~325 mounted paths** (`entities.js` generates 5 verbs × 23 entities = 109 paths from one loop). Full matrix below. |
| 4 | **Auth** | JWT access cookie + rotating refresh, or `Bearer`, or `ApiKey`. Enforced **per-router** (`router.use(authMiddleware)`), not globally. `middleware/auth.js` |
| 5 | **Data layer** | Prisma. Postgres RLS exists (`prisma/rls.sql`), is fail-closed, and uses `FORCE ROW LEVEL SECURITY` — but covers **47 of 78 models** (only those with a literal `orgId` column, minus `User`), is **absent from 3 of 5 deploy paths** (F-2b), and does **not** cover the RAG store (F-2c) or the in-process run cache (F-2). SQLite (the checked-in default) has none. Net: authorization is enforced in **application code**, with a partial DB backstop. |
| 6 | **Deploy target** | Fly.io (`fly.toml`, app `scopecash-ai`, region `iad`) or Railway — both apply RLS via release/pre-deploy hooks. Helm, docker-compose, Cloud Run and bare Docker **do not** (F-2b). Production refuses SQLite (`index.js:26-31`). I could not confirm a live deployment — see "What I could NOT verify". |
| 7 | **Tests & CI** | **45 suites / 495 tests — 464 pass, 31 skipped, 0 fail** (executed this session, 109s). CI (`.github/workflows/ci.yml`) is genuinely strong: real Postgres, RLS applied, **non-superuser role**, plus CodeQL, gitleaks, Trivy, cosign signing. |
| 8 | **Secrets** | ✅ **No live secret committed.** `git ls-files` shows only `.env.example` / `.env.connectors.example`. History clean. Client bundle exposes only `REACT_APP_API_URL` + Sentry DSN — both safe by design. |

---

## Threat model (what I prioritized, and why)

1. **Most valuable data:** rate sheets + contracts (competitive), then the money ledger, then geotagged evidence.
2. **Cheapest path in:** register a free account (`POST /api/auth/register`, open unless `BETA_MODE`), then walk object IDs on routes that don't check ownership. No payment, no approval.
3. **Worst authenticated-malicious action:** read/cancel/execute another tenant's agent runs, workflows, and goals (F-2) — leaking whatever contract text was in that run.
4. **Worst bug affecting a legitimate user:** a wrong number on a change-order packet. This is a document submitted in commercial disputes.
5. **Does anything move/calculate/report money?** Yes — and **it is stored in binary floating point with no rounding, and the pricing engine has no test at all.** That is F-1.

**I weighted money-correctness equal to security, and cross-tenant isolation above
privilege escalation.** If you think the competitive value of rate sheets is lower than I
assumed, F-2's severity drops but F-1's does not.

---

# CRITICAL

## F-1. All money is IEEE-754 floating point, never rounded, and completely untested — VERIFIED

**Every one of the 38 money fields in the schema is `Float`. There are zero `Decimal` columns.**

`server/prisma/schema.prisma:1294-1303`, `:1098-1103`, `:1156`, `:1183-1185`:
```prisma
quantity     Float?      unitCost     Float?      totalCost    Float?
markupAmount Float?      taxAmount    Float?      billedTotal  Float?
identified_amount Float?  ... collected_amount Float?
ratePercent  Float       collectedAmount Float    feeAmount    Float
```

`server/lib/pricing.js:11-21` does the arithmetic with no rounding anywhere:
```js
const markupAmount = markupRate != null ? effectiveTotal * markupRate : null;
const taxAmount    = taxRate   != null ? (effectiveTotal + (markupAmount || 0)) * taxRate : null;
const billedTotal  = effectiveTotal + (markupAmount || 0) + (taxAmount || 0);
```

**Repro (executed against the real function this session):**

```
computeCostItemPricing({unitCost:1.10, quantity:3, markupRate:0.15, taxRate:0.0825})
→ { totalCost:    3.3000000000000003,
    markupAmount: 0.495,
    taxAmount:    0.3130875,          ← sub-cent, persisted as-is
    billedTotal:  4.108087500000001 }

computeCostItemPricing({unitCost:1234.56, quantity:78, markupRate:0.175, taxRate:0.0875})
→ { markupAmount: 16851.744, taxAmount: 9900.399599999999,
    billedTotal:  123047.8236 }       ← invoice total carrying 4 decimal places

Summing 1000 line items of $0.07 → 69.99999999999966 (drift −3.4e-13)
```

**Why it matters.** These values are written to the database unrounded, then summed
across line items into packet totals and into the six-stage ledger. Two different code
paths that round at different points produce different customer-visible totals for the
same packet. The output is a **change-order claim document** — a contractor whose packet
says `$123,047.8236` where their own accounting says `$123,047.82` has a credibility
problem in exactly the dispute the product exists to win.

It compounds: `collected_amount` feeds `computeSuccessFee` (`lib/success-fee.js:16`),
which *does* round — but rounds an already-drifted input.

**No test covers any of this.** 45 test suites, and `lib/pricing.js` has none. Verified:
`find tests -name "*pricing*"` → empty. `tests/unit/success-fee.test.js` covers the fee
percentage only, not the pricing engine feeding it.

**Fix:** store money as integer minor units (cents) or Prisma `Decimal`; round to 2dp at
every persistence boundary. Add a pricing test with the drift cases above. This is a
migration, not a one-line change — scope it deliberately.

## F-2. Cross-tenant IDOR on agent runs, workflow runs, and goals — VERIFIED

`server/lib/run-store.js:46-55` — a bare id lookup with **no org filter**, and an
in-process cache checked *before* the database:
```js
async function get(id) {
  if (_cache.has(id)) return _cache.get(id);        // ← Map keyed by id only, no org
  const row = await prisma.agentRun.findUnique({ where: { id } });   // ← no orgId
```

**The cache makes this exploitable even on Postgres with RLS enabled.** A run cached by
org A's request is returned to org B's request without the query ever reaching the
database, so the RLS policy never evaluates. This is the one place in the codebase where
the documented "hard database-level backstop" (`prisma/rls.sql:6-8`) does not apply.

Reachable, unguarded, by **any authenticated user of any org**:

| Endpoint | file:line | Impact |
|---|---|---|
| `GET /api/workflows/runs/:id` | `routes/workflows.js:34` | reads another tenant's run input + output |
| `POST /api/workflows/runs/:id/cancel` | `routes/workflows.js:41` | **cancels** another tenant's running workflow |
| `GET /api/goals/:id` | `routes/goals.js:29` | reads another tenant's goal, plan, and full trace |
| `POST /api/goals/:id/approve` | `routes/goals.js:61` | **approves and executes** another tenant's plan |
| `GET /api/agents/runs/:id` | `routes/agents.js:175` | `asyncRunner.getRun` is `store.get` (`async-runner.js:131`) — same hole |

Run `input`/`output` hold up to 8,000 / 16,000 chars of contract and evidence text
(`run-store.js:24-25`), so this leaks the source documents, not just metadata.

`goals.js:61` is the worst: `orchestrator.approveGoal(id, ctx)` (`lib/orchestrator.js:88-93`)
executes the **victim's** plan under the **attacker's** ctx, returning the victim's goal
text and every step output to the attacker — while billing the attacker's org for the
LLM spend.

**Repro:** as user in org B, `GET /api/goals/<any goal id from org A>` → `200` with org
A's data. Returns 200, so no error tracker will ever surface it.

**The fix already exists in this repo** — `routes/agents.js:100-102` does it correctly:
```js
const ownsRun = (run.orgId && run.orgId === req.user.orgId) || (run.userId && run.userId === req.user.id);
if (!ownsRun) throw new HttpError(404, 'Run not found', 'run_not_found');
```
Apply that same check to the five endpoints above, and scope the `_cache` key by org.

**Bonus enumeration primitive — VERIFIED.** `lib/run-store.js:61`:
```js
where: { ...(kind ? { kind } : {}), ...(orgId ? { orgId } : {}) },
```
A falsy `orgId` **drops the filter entirely** rather than failing closed. `User.orgId` is
nullable (`schema.prisma:7`, `String?`) and `routes/goals.js:25` passes `req.user.orgId`
straight through. **For any user whose `orgId` is null, `GET /api/goals` returns every
tenant's goals** — no id guessing required. Registration always creates an org, so this
needs a pre-migration or invitation-orphaned account, but it is a mass-enumeration path,
not a targeted one.

## F-2b. RLS — the documented backstop — is absent from 3 of 5 deploy paths — VERIFIED

`prisma/rls.sql:6-8` describes itself as *"a HARD database-level backstop … even a route
that forgets to filter cannot leak another tenant's rows."* That is only true where the
policies were actually created. RLS is applied by `npm run db:postgres:rls`, chained into
`db:postgres:deploy` (`package.json:24`). Where that runs:

| Deploy path | RLS applied? | Evidence |
|---|---|---|
| Fly.io | ✅ Yes | `fly.toml:60` `release_command = "npm run db:postgres:deploy"` |
| Railway | ✅ Yes | `railway.json:8` `preDeployCommand` |
| **docker-compose** | ❌ **No** | `docker-compose.yml:41` — `npx prisma migrate deploy … && node index.js`. Migrations only. |
| **Helm / Kubernetes** | ❌ **No** | grep across `deploy/helm/` for `migrate\|rls\|db:postgres` returns **nothing** — no initContainer, no migration Job |
| **Cloud Run / terraform-gcp** | ❌ **Manual** | `DEPLOY.md:72` — *"Cloud Run has no pre-deploy hook"*; operator must run it by hand |
| Bare `Dockerfile` | ❌ No | `CMD ["node","index.js"]` |

**A Helm or docker-compose Postgres deployment runs with the RLS policies never created —
the same exposure as SQLite, while every doc says the backstop is there.** Nothing checks
at boot. `rls.sql` is idempotent, so a startup assertion is cheap.

**Why this matters for every other finding:** several findings below are "RLS-mitigated on
Postgres." That mitigation is conditional on the deploy path, not on the database engine.

## F-2c. The RAG knowledge base can never be RLS-protected — VERIFIED

`prisma/rag-pgvector.sql:14-16` names the tenant column **`namespace`**, not `orgId`:
```sql
CREATE TABLE IF NOT EXISTS rag_chunks (
  id         text PRIMARY KEY ...,
  namespace  text NOT NULL,     -- tenant/org id
```
`prisma/rls.sql:34-37` selects tables `WHERE c.column_name = 'orgId'`. **It never sees this
table, so no policy is ever created on it — on any deploy path, including Fly.**

Compounding, `lib/rag/vector-store.pg.js:20` opens its **own** connection pool:
```js
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```
This bypasses `lib/prisma.js` entirely, so `SET LOCAL app.org_id` is never issued on that
connection — even if a policy existed, it could not apply.

Tenant isolation for every document a customer ingests into the knowledge base rests
entirely on the literal `WHERE namespace = $1` at `vector-store.pg.js:52` and `:66`.
`routes/knowledge.js` does pass `req.user.orgId` correctly today, so **there is no live
leak** — but there is no second line of defence, and `DELETE /api/knowledge` is reachable
by a `viewer` (F-4). The in-memory backend collapses null-org users into a shared
`'default'` namespace (`vector-store.js:22`).

## F-3. Outcome billing silently reports success while Stripe rejects every call — VERIFIED (executed)

`server/lib/outcomes.js:50` calls a method that **does not exist** in the installed SDK:
```js
await stripe.subscriptionItems.createUsageRecord(subscriptionItem, {...});
```

Stripe removed `createUsageRecord` in favour of Billing Meters. Installed version is
**22.3.2**. Confirmed by direct introspection:
```
subscriptionItems.createUsageRecord → undefined
billing.meterEvents.create         → function
```

**Executed the real path this session:**
```
recordOutcome({orgId,userId,outcomeId}, 'success_fee_collected')
→ { billed: true,                              ← the app believes it billed
    stripe: { reported: false,
              reason: "stripe.subscriptionItems.createUsageRecord is not a function" } }
```

The TypeError is swallowed by the `catch` at `:54`, and the one caller
(`routes/entities.js:827-832`) discards the result with `.catch(() => {})`. **Nothing logs,
alerts, or fails.**

All six configured billable events are affected: `pilot_audit_purchased`,
`standard_audit_purchased`, `starter/professional/enterprise_subscription_activated`,
`success_fee_collected`.

**This is uncollected revenue, not a security hole — which is why it is here rather than
in MEDIUM.** Every metered outcome charge since this shipped has been recorded locally as
`billed: true` and never transmitted to Stripe. `lib/outcomes.js:9` also admits the
counters are in-memory ("Counters are in-memory for v1"), so a restart erases the only
local record that the charge ever happened.

**Fix:** migrate to `stripe.billing.meterEvents.create`, and make a Stripe reporting
failure loud (log at error + alert) rather than a discarded return field.

---

# HIGH

## F-4. `requireScope()` is not an authorization control — VERIFIED

`middleware/auth.js:34` gives **every** cookie/Bearer session full scope:
```js
req.authScopes = ['*']; // user session = full scope
```
`middleware/auth.js:82` then short-circuits:
```js
if (scopes.includes('*')) return next();
```

**For a browser session, `requireScope(...)` is a pass-through.** Roughly 34 endpoints
across `project.js`, `ai.js`, `agents.js`, `workflows.js`, `goals.js`, `knowledge.js`,
`outcomes.js` and `dsar.js` carry it as their only guard beyond authentication. In
practice those routes are "any authenticated user, any role, including `viewer`":

| Endpoint | file:line | What a `viewer` can do |
|---|---|---|
| `DELETE /api/projects/:id` | `project.js:145` | delete any project in their org |
| `POST /api/projects` | `project.js:71` | create projects / upload |
| `DELETE /api/knowledge` | `knowledge.js:55` | **wipe the org's entire knowledge base** |
| `POST /api/outcomes/record` | `outcomes.js:30` | meter billable events |

**And it is inert on the API-key path too**, because `routes/apikey.js:44` has no role
gate and `VALID_SCOPES` (`:15`) includes `'*'` — so any user, including a `viewer`, can
mint themselves a full-scope key.

**Verified boundary:** this does *not* escalate past `requireAnyOrgRole`, which reads
`req.orgRole` from `OrgMembership` (`middleware/tenant.js:83-92`) and is unaffected by
scopes. `entities.js`, `evidence.js` and `organization.js` use that mechanism and are
genuinely well-governed. The RBAC machinery works — it simply was not applied to the
seven routers above.

## F-5. Billing actions have no role gate — VERIFIED

`routes/billing.js` applies `authMiddleware` at `:21` but **no role check** on:

| Endpoint | file:line | Impact |
|---|---|---|
| `POST /api/billing/cancel` | `:100` | **any org member cancels the org's subscription** |
| `POST /api/billing/portal` | `:84` | opens Stripe portal — payment-method access |
| `POST /api/billing/checkout` | `:60` | starts a checkout |

```js
router.post('/cancel', async (req, res, next) => {
  const sub = await dunning.cancel({ orgId: req.user.orgId, atPeriodEnd: true });
```
Not cross-tenant (`req.user.orgId` is the caller's own org) — this is **privilege
escalation within the org**. A `viewer` — the lowest role, typically an outside estimator
or a client-side observer — can terminate the company's subscription.

The repo already knows the pattern: `routes/success-fee.js:40` gates a *less* consequential
billing action with `requireAnyOrgRole('owner','admin')`.

## F-6. AI spend ceiling reads a table that one endpoint writes — VERIFIED

`lib/ai-budget.js:55` enforces the USD monthly budget by aggregating `AiSpendEvent`.
Exhaustive grep for writers across `lib/`, `routes/`, `jobs/`:
```
lib/ai-budget.js:133   (definition)
lib/ai-budget.js:212   (export)
routes/ai.js:115       ← the ONLY production caller
lib/ai-budget.js:137   ← the only aiSpendEvent.create
```

**`routes/ai.js` is the only endpoint on the server that records spend.** The evidence
pipeline (the actual product — Vertex Gemini over contracts and photos), workflows, goals,
knowledge ingest, and async agent runs all spend real money and write nothing. The
guard itself is correctly pre-spend and blocking (`ai-budget.js:92-100` returns 429) — it
is simply measuring a number that stays near zero.

Compounding, all VERIFIED:
- **`POST /api/agents/:name/run/async`** (`routes/agents.js:155`) has no `checkAiQuota` — unlike its sync (`:50`) and stream (`:117`) siblings — and `async-runner.js` records no usage. 20 req/min/user, each spawning a background agent tree, every counter at zero.
- **`routes/evidence.js` imports `limiters` at `:22` and never uses it** (verified: 0 occurrences of `limiters.` in the file). No `aiBudgetGuard` either.
- **`aiBudgetGuard` fails open** (`ai-budget.js:118-125`) *and* sets `utilization: 0`, which re-enables premium model routing at the moment the ceiling breaks.
- **Agent loop bound is combinatorial.** `MAX_STEPS=8` (`agent-runtime.js:20`), but cascade re-runs a step on the premium model when a turn is under 8 characters (`:273-284`), and `delegate_to_agent` recurses to `MAX_DEPTH=3` (`:26`) with **no cap on tool calls per turn** (`:302`). Worst case is thousands of round-trips for one HTTP request.
- **`lib/orchestrator.js:99`** iterates `g.steps` — a step list authored by the LLM (`:29-38`) with **no length cap** — each step a full agent tree.
- **`lib/evidence-jobs.js:384-388`** — three `findMany` with **no `take:`**, every row becoming a Gemini prompt part. Prompt size grows without limit in project size. Note `evidence-pipeline.js:304` caps a *cheaper* query at 8 with a comment about unbounded growth; the reasoning wasn't applied here.

**Fix (smallest first):** call `recordAiSpend` from the evidence pipeline and agent
runtime; add `take:` to the three queries; mount `aiBudgetGuard` + `limiters.ai` on
`routes/evidence.js`.

## F-6b. Data-products streams every tenant's users and orgs — VERIFIED

`GET /api/data-products/:id/preview` (`routes/data-products.js:37-49`) streams warehouse
products as NDJSON. Two of them have no tenant filter at all (`lib/warehouse.js:59-80`):

```js
// users_dim
const where = sinceMs ? { createdAt: { gte: ... } } : {};   // ← {} when no sinceMs
return _pageById(prisma.user, where, ...)

// orgs_dim
return _pageById(prisma.organization, {}, o => ({           // ← literally {}
  id: o.id, name: o.name, plan: o.plan || null, ...
}));
```

**RLS cannot save either one.** `User` is *explicitly excluded* from RLS
(`prisma/rls.sql:37`) because auth happens before an org context exists, and
`Organization` has no `orgId` column so the scan never selects it. **These leak on every
deploy path, Postgres included.**

`orgs_dim` returns every customer organization's **name and plan** — a direct customer
list. `users_dim` redacts email to domain+hash (real mitigation) but still exposes
`org_id`, `role`, `created_at`, `last_login_at` for every user on the platform.
`data-products.js:70` likewise lists `dataExport` unfiltered (no `orgId` column).

Gated on platform admin (`data-products.js:26-31`), which per F-11 is not customer-
reachable — so this is an operator-console exposure, not a tenant-to-tenant one. It
belongs here rather than in CRITICAL for that reason.

## F-6c. `routes/ai-admin.js` — four unscoped queries, two unprotectable — VERIFIED

```
ai-admin.js:129  GET /evals         evalRun.findMany({ orderBy, take: 20 })      ← no where
ai-admin.js:154  GET /observability aiUsage.findMany({ where: { createdAt } })   ← no orgId
ai-admin.js:176  GET /observability evalRun.findMany({ orderBy, take: 50 })      ← no where
ai-admin.js:185  GET /observability aiSpendEvent.groupBy({ where: { period } })  ← no orgId
```

Two handlers up, `GET /spend` (`:47`) *is* scoped with `where: { orgId: req.user.orgId }`,
and `GET /spend/:orgId` (`:78-80`) has an explicit cross-org 403. So these are missed
filters, not design. **`EvalRun` has no `orgId` column**, so `:129` and `:176` leak across
tenants even on Postgres; `:154` and `:185` hit tables RLS does cover.

## F-7. Cross-tenant OAuth-app deletion — VERIFIED

`lib/oauth-apps.js:56`:
```js
async function deleteApp(clientId) {
  await prisma.oAuthApp.deleteMany({ where: { clientId } }).catch(() => {});
}
```
No `orgId` filter, while the sibling `listApps` (`:51-52`) *is* org-scoped. Reached from
`routes/marketplace.js:114`.

**Mitigation that actually holds:** `OAuthApp` has an `orgId` column, so `prisma/rls.sql`
covers it and Postgres blocks the cross-org delete. **On SQLite there is no protection at
all**, and the `.catch(() => {})` means the caller cannot tell the difference between
"deleted" and "blocked". Requires platform-admin (`marketplace.js:70`), which limits
real-world exposure.

## F-8. No `unhandledRejection` / `uncaughtException` handlers anywhere — VERIFIED

Exhaustive search across the whole server (excluding `node_modules`) returns **zero
matches** for either handler. Node ≥15 terminates the process on an unhandled rejection by
default, so a single unawaited promise rejection in any background scheduler
(`usageAggregator`, `lifecycleTriggers`, `warehouseExport`, `orgDeletionSweep`,
`requestSampler`, all started at `index.js:312-318`) takes the API down.

`index.js:331-386` handles `SIGTERM`/`SIGINT` gracefully but a crash bypasses all of it:
in-flight requests are dropped, buffered API-call counts in `lib/api-call-meter.js` are
lost, and `growthEvents` never drains.

**Partial mitigation, verified:** evidence jobs are durable (`EVIDENCE_JOB_MAX_ATTEMPTS=5`
with a real dead-letter at `evidence-jobs.js:507-518`) and a reconciler sweeps stuck jobs
(`:475`), so evidence work survives. Nothing else does.

---

# MEDIUM

## F-9. `npm test` reports PASS while the entire tenant-isolation suite skips — VERIFIED

`tests/postgres/rls.test.js` reports `PASS` in the default run. Executed in isolation:
```
Tests: 19 skipped, 1 passed, 20 total
```
Nineteen skipped tests include *"runWithOrg(orgA) cannot see orgB rows"*, *"a query with NO
tenant context sees zero rows (fail-closed)"*, and the success-fee fail-closed regression.
They skip because `DATABASE_URL` isn't Postgres (`tests/postgres/rls.test.js:11-15`).

**This is precisely the "absence of a response mistaken for safety" pattern.** A local
green run tells you nothing about tenant isolation.

**What would have made this check fail:** if RLS were genuinely unverified, CI would also
skip. It does not — `.github/workflows/ci.yml:67-71` runs `npm run test:postgres-rls`
against real Postgres **as a dedicated non-superuser role** (`:54-58`), because superusers
bypass RLS. That is correct and I verified it by reading the workflow. **So RLS is tested
— but only in CI, and only on push/PR to `master`.** The local signal is misleading, which
matters for a solo founder who tests before pushing.

## F-10. Account erasure does not invalidate the session — VERIFIED

`routes/dsar.js:87-88` clears cookies named `'auth'` and `'refresh'`. The real cookies are
`'access_token'` (`middleware/auth.js:5`) and `'refresh_token'` (`lib/session.js:16`).
After a GDPR Art. 17 erasure the user keeps a fully valid 15-minute access token and a
working refresh token, contradicting the docstring at `:57-58`. One-line fix.

## F-11. `GET /api/admin/tenants/:orgId/cost` accepts any org id — VERIFIED, low exploitability

`routes/tenants.js:84,92`:
```js
const data = await runWithOrg(req.params.orgId, () => cost.getTenantCosts(req.params.orgId, period));
```
`runWithOrg` **sets the RLS context to the attacker-supplied org**, so RLS cannot help
here by design. `routes/ai-admin.js:80` guards the identical pattern with an explicit
`orgId !== req.user.orgId` → 403.

**Severity is MEDIUM, not CRITICAL, and here is the check that decides it:** `User.role`
defaults to `"user"` (`schema.prisma`), and `POST /api/auth/register` (`routes/auth.js:63-69`)
never sets it — new users get `orgMembership.role = 'owner'`, which is a *different* field.
I verified the only writes of `role: 'admin'` in `routes/organization.js:199-203` target
`orgMembership`, not `User`. **So platform-admin is not customer-reachable**, and these
routes are an operator console. Still worth fixing for consistency.

## F-12. Unauthenticated write + token-in-URL on the trust portal — VERIFIED

- `POST /api/trust-portal/kits/request` (`:75`) — no auth, no rate limiter, creates a DB row and captures an email. The docblock at `:7` claims it is rate limited; **no limiter is attached**.
- `GET /api/trust-portal/kits/download` (`:90`) — bearer token in the query string, which `index.js:174` writes to the access log and browsers leak via `Referer`.

## F-13. Dependency vulnerabilities — VERIFIED

`npm audit --omit=dev` executed this session: **61 vulnerabilities (45 moderate, 16 high)**,
all transitive through `@google-cloud/storage` → `teeny-request`/`retry-request`/`uuid`.
CI reports but does not block (`ci.yml:93-96`), with an honest comment explaining that
7.21.0 is already the latest published release. The comment says 18 high; the actual
current count is **16 high / 61 total**. Not fixable from this repo today.

## F-14. Other verified MEDIUMs

| Finding | file:line | Note |
|---|---|---|
| Webhook SSRF | `routes/webhook.js:23` | any member registers an arbitrary egress URL; no private-IP filter. Rows are `userId`-scoped, so outside RLS. |
| `POST /api/auth/verify-email` missing `limiters.auth` | `routes/auth.js:200` | the only token-consuming auth route without it (cf. `:41,:95,:216,:236`) |
| Password hash before authz check | `routes/setup.js:78` vs `:81-85` | anonymous caller forces a bcrypt on an already-configured deploy |
| OAuth auto-approve | `routes/oauth.js:34-47` | "For headless flow, auto-approve" — no consent UI, no CSRF. `redirect_uri` **is** allowlisted (`lib/oauth-apps.js:64-74`), so not an open redirect. |
| `/oauth` outside `/api` | `index.js:219` | escapes `limiters.global` (`:186`) and `csrfProtect` (`:190`) |
| Double metering | `index.js:195` vs `:208-209` | `/api/admin/*` runs `attachTenant` twice → two quota increments per request |
| `mapStripeStatus` defaults to `'active'` | `stripe-webhook.js:218` | unknown Stripe status grants an active subscription — fail-open |
| Success-fee stacking | `lib/success-fee.js:25` + `entities.js:786` | re-transitioning to `collected` is allowed (`targetIdx < currentIdx` only blocks *backward*), creating an additional `EarnedRevenueEvent` each time. The schema comment (`:1170-1173`) says this is intentional for corrections — but nothing nets the prior event out, so a corrected outcome's fees **sum**. |
| Safety gate disabled | `lib/safety.js:15` | `gated: false` on a platform the README explicitly warns not to deploy into "a regulated, financial, or safety-critical workflow" |

---

# LOW

| Finding | file:line | Note |
|---|---|---|
| `jwt.verify` without `algorithms` allowlist | `lib/security.js:30` | Hygiene only. jsonwebtoken v9 rejects `alg:none`, and the key is an HMAC secret (not an RSA public key), so the confusion attack does not apply. Add `algorithms:['HS256']` anyway. |
| `GET /api/docs` relaxes CSP | `routes/docs.js:13-18` | allows `cdn.jsdelivr.net` + `unsafe-inline` on a same-origin page |
| `GET /api/docs/openapi.json` public | `routes/docs.js:5` | publishes every admin endpoint path to anonymous callers |
| `GET /api/health/version` public | `routes/health.js:43` | exact `GIT_SHA` aids CVE targeting |
| `GET /api/status` public | `routes/status.js:15` | exposes SLO error-budget burn |
| Unsanitized export filename | `routes/export.js:62` | CSV sibling sanitizes at `:46`; JSON route does not |
| Admin sub-router fragility | `growth.js:74`, `marketplace.js:68` | no own `authMiddleware`; relies on parent ordering. Swapping two lines exposes flag management anonymously **with no test failure**. `trust-portal.js:100` does it correctly. |
| `/api/admin/growth/*` documented, `/api/growth/admin/*` actual | `growth.js:12-15` | docblock disagrees with the mount |

---

# Verified clearances (things I checked that are genuinely fine)

Stating these with the enforcing code, per the rule that a clearance needs evidence too.

| Claim | Enforcing code | What would have made this fail |
|---|---|---|
| **No live secret in the repo or git history** | `git ls-files` → only `*.example`; history scan clean | any tracked `.env`, `.pem`, or key file |
| **No secret in the client bundle** | only `REACT_APP_API_URL`, `REACT_APP_SENTRY_*` | any `REACT_APP_*KEY/SECRET/TOKEN` |
| **Stripe webhook cannot be forged** | `stripe-webhook.js:28` HMAC via `stripe.verifyWebhook`; `:31` returns 400 before any write | a handler that parsed `req.body` before verifying |
| **Webhook replay is safe** | dedup row written **inside** the same `tenantTransaction` as the mutation (`:70-86`); rolls back together | a dedup marker committed separately |
| **The classic "route above `router.use(auth)`" bug is absent** | all 39 files checked; the only 2 cases (`billing.js:13`, `marketplace.js:23`) are deliberate public endpoints | any accidental pre-auth route |
| **No admin endpoint checks only `if (session)`** | every admin router checks `req.user.role !== 'admin'` → 403 (`admin.js:10-13`, `tenants.js:19-24`, `ai-admin.js:25-30`, `operations.js:24-29`, `governance.js:36-41`, `data-products.js:26-31`, `competition.js:21-26`) | a bare truthiness check |
| **Platform admin is not customer-reachable** | `User.role @default("user")`; register never sets it; `organization.js:199-203` writes `orgMembership`, not `User` | any path writing `user.role = 'admin'` |
| **CSRF bypass via `Bearer` header is not exploitable** | `csrf.js:33` skips on Bearer *and* auth prefers the cookie (`auth.js:13-16`) — but `sameSite:'lax'` (`session.js:22`) stops the cookie riding a cross-site POST, and CORS (`index.js:137-144`) rejects the preflight | `sameSite:'none'`, or a permissive `CORS_ORIGIN` |
| **RLS policy logic is correctly fail-closed** (where applied) | `rls.sql:47-54` — no `IS NULL` escape hatch; `FORCE ROW LEVEL SECURITY` at `:42` so the owner role is subject too | an `OR current_setting(...) IS NULL` clause. **Scope limit:** this clears the *policy*, not its coverage — see F-2b (deploy paths) and F-2c (RAG). |
| **`entities.js` uses no `findUnique` at all** | every single-row read is `findFirst` and every write is `updateMany`/`deleteMany`, specifically so `orgId` can be ANDed with `id`; all funnel through `scope()` (`entities.js:326`) | a single `findUnique({where:{id}})` in the domain CRUD layer |
| **No handler trusts a client-supplied `orgId` in the body** | zero occurrences of `req.body.orgId` codebase-wide; the one query-param case (`growth.js:86`) is admin-gated | any `orgId` read from request body |
| **Production cannot boot on SQLite** | `index.js:26-31` exits if `DATABASE_URL` starts with `file:` | a warning instead of `process.exit(1)` |
| **JWT_SECRET placeholder/short values refuse to boot** | `index.js:16-25` | a default fallback secret |
| **Unauthenticated users cannot trigger paid LLM calls** | every LLM router has `router.use(authMiddleware)`; the one public job route (`jobs.js:15`) verifies a Google OIDC push token with a pinned service account (`lib/cloud-tasks.js:67-71`) | a dev/test bypass, or a missing audience check |
| **Retries are capped everywhere** | Vertex `retries:3` (`vertex-ai.js:90`); BullMQ `attempts` 3–5 with exponential backoff (`evidence-jobs.js:57-62`, `async-runner.js:33-38`, `worker.js:31-36`); real dead-letter (`evidence-jobs.js:507-518`) | an uncapped retry or a poison-message loop |
| **`entities.js` / `evidence.js` / `organization.js` RBAC is real** | `requireAnyOrgRole` against `req.orgRole` from `OrgMembership` (`tenant.js:83-92`), fail-closed to `viewer`; gates precede `validate()` | a scope check instead of a role check |
| **Login is hardened** | generic errors (`auth.js:100`), lockout after 8 (`security.js:60-61`), `limiters.auth`, no user enumeration on forgot-password (`:218`) | distinct "no such user" vs "wrong password" |
| **Path traversal is guarded on file-serving routes** | `lib/trust-pack.js:123-125`, `lib/board-reports.js:212-216`, `data-products.js:84-94` | raw `path.join` on a param |

---

# 1. Endpoints with no authorization guard — raw list

36 anonymous-reachable endpoints. The last two have a verified cryptographic guard instead
of session auth; the rest are genuinely open.

```
GET    /api/health                          routes/health.js:7
GET    /api/health/live                     routes/health.js:25
GET    /api/health/ready                    routes/health.js:30
GET    /api/health/version                  routes/health.js:43        [leaks GIT_SHA]
GET    /api/health/integrations             routes/health.js:54        [leaks integration inventory]
POST   /api/auth/register                   routes/auth.js:41
POST   /api/auth/login                      routes/auth.js:95
POST   /api/auth/refresh                    routes/auth.js:138
POST   /api/auth/logout                     routes/auth.js:177
POST   /api/auth/verify-email               routes/auth.js:200         [NO limiters.auth — outlier]
POST   /api/auth/forgot-password            routes/auth.js:216
POST   /api/auth/reset-password             routes/auth.js:236
GET    /api/billing/plans/public            routes/billing.js:13       [intentional]
GET    /api/marketplace/catalog             routes/marketplace.js:23   [intentional]
GET    /api/trust/summary                   routes/trust.js:18
GET    /api/trust/documents/:name           routes/trust.js:23
GET    /api/trust/pack                      routes/trust.js:32
GET    /api/status                          routes/status.js:15        [exposes SLO error budgets]
GET    /api/status/incidents                routes/status.js:46
GET    /api/status/uptime                   routes/status.js:56
GET    /api/trust-portal/questions          routes/trust-portal.js:29
GET    /api/trust-portal/questions/:id      routes/trust-portal.js:40
GET    /api/trust-portal/one-pager          routes/trust-portal.js:47
POST   /api/trust-portal/kits/request       routes/trust-portal.js:75  [unauth DB write; documented limiter ABSENT]
GET    /api/trust-portal/kits/download      routes/trust-portal.js:90  [bearer token in query string]
GET    /api/docs/openapi.json               routes/docs.js:5           [publishes full admin API surface]
GET    /api/docs                            routes/docs.js:11          [relaxes CSP]
GET    /api/help/categories                 routes/help.js:400
GET    /api/help/articles                   routes/help.js:404
GET    /api/help/articles/:slug             routes/help.js:408
GET    /api/setup/status                    routes/setup.js:65
POST   /api/setup/complete                  routes/setup.js:70         [self-limiting; hash runs BEFORE check]
POST   /oauth/token                         routes/oauth.js:66         [client_secret; outside /api limiter]
POST   /oauth/revoke                        routes/oauth.js:96         [client_secret; outside /api limiter]
POST   /api/jobs/process-task               routes/jobs.js:15          [GUARDED: Google OIDC push token]
POST   /api/billing/webhook/stripe          routes/stripe-webhook.js:17 [GUARDED: Stripe HMAC]
```

**Authenticated but no role check — the higher-impact subset:**
```
POST   /api/billing/cancel                  routes/billing.js:100   [cancels the org subscription]
POST   /api/billing/portal                  routes/billing.js:84    [payment-method access]
POST   /api/billing/checkout                routes/billing.js:60
POST   /api/api-keys                        routes/apikey.js:44     [any user mints scopes:'*']
DELETE /api/projects/:id                    routes/project.js:145
POST   /api/projects                        routes/project.js:71
POST   /api/projects/batch                  routes/project.js:87
DELETE /api/knowledge                       routes/knowledge.js:55  [wipes org knowledge base]
POST   /api/outcomes/record                 routes/outcomes.js:30
POST   /api/marketplace/install/:id         routes/marketplace.js:47
DELETE /api/marketplace/install/:id         routes/marketplace.js:60
POST   /api/webhooks                        routes/webhook.js:23    [arbitrary egress URL]
```

**Cross-tenant / IDOR:**
```
GET    /api/workflows/runs/:id               routes/workflows.js:34   lib/run-store.js:46 — no orgId
POST   /api/workflows/runs/:id/cancel        routes/workflows.js:41   same
GET    /api/goals/:id                        routes/goals.js:29       lib/orchestrator.js:121
POST   /api/goals/:id/approve                routes/goals.js:61       executes victim's plan
GET    /api/agents/runs/:id                  routes/agents.js:175     async-runner.js:131 = store.get
DELETE /api/marketplace/oauth-apps/:clientId routes/marketplace.js:114 lib/oauth-apps.js:56
GET    /api/admin/tenants/:orgId/cost        routes/tenants.js:84     operator-only
GET    /api/admin/tenants/:orgId/margin      routes/tenants.js:92     operator-only
GET    /api/admin/ai/observability           routes/ai-admin.js:149   no orgId filter (RLS-dependent)
GET    /api/admin/ai/evals                   routes/ai-admin.js:127   no orgId filter
```

---

# 2. What I could NOT verify — the honest boundary

1. **Whether this is deployed and serving.** I made no network request. `fly.toml` names
   `scopecash-ai` in `iad`, but a config file is not a deployment. **To verify I would need
   `fly status -a scopecash-ai` or a URL you confirm is yours.** I deliberately did not
   probe — and note that a 404, a connection error, or a 405 would prove nothing either way.

2. **Whether any exploit actually works against a running instance.** Every finding is
   read from source. I executed `lib/pricing.js` and `lib/outcomes.js` directly (those two
   are proven), but I did not stand up the server and issue cross-tenant requests. **To
   verify F-2, boot the app with two orgs and `GET /api/goals/<org-A-id>` as an org-B
   user.** I recommend doing this before acting on F-2's severity.

3. **RLS behaviour under real Postgres.** 19 of 20 RLS tests skipped locally. CI runs them
   properly, but I did not see a CI run — I read the workflow file. **To verify: check the
   latest Actions run on `master` is green.**

4. **The `_cache` cross-tenant claim in F-2 under production conditions.** The code path is
   unambiguous (`run-store.js:46`, Map keyed by id alone), but cache hit rate depends on
   process lifetime and traffic. **To verify: two orgs, same process, read a run id created
   by the other org within the process lifetime.**

5. **Real Stripe behaviour.** I proved `createUsageRecord` is `undefined` in the installed
   SDK and that the error is swallowed. I did **not** confirm against a live Stripe account
   that no usage is arriving. **To verify: check the Stripe dashboard for usage records on
   any metered subscription item.** If you see none, F-3 is confirmed in production.

6. **Actual float drift in your live data.** I proved the formula drifts. I did not query a
   production database for stored values with more than 2 decimal places. **To verify:
   `SELECT billedTotal FROM CostItem WHERE billedTotal <> ROUND(billedTotal, 2)`.**

7. **The dashboard.** I audited the API surface and confirmed no client-side secrets. I did
   **not** audit React components for XSS, unsafe `dangerouslySetInnerHTML`, or client-side
   authorization assumptions.

8. **`entities.js` per-entity ownership filters at the row level.** I verified the `scope()`
   helper exists (`entities.js:327`) and that role gates precede validation, but I did not
   trace all 109 generated CRUD paths individually.

9. **Whether the six-stage ledger totals are correct end to end.** I audited the transition
   handler and the fee computation. I did not verify that the dashboard's funnel
   visualization sums them the way the schema intends, nor that `identified` → `collected`
   reconciles.

10. **Which deploy path you actually use.** F-2b's severity depends entirely on this. If you
    are on Fly or Railway, RLS is applied and F-2b is informational. If you are on Helm,
    docker-compose, or Cloud Run, it is critical. **To verify:
    `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation';` against your
    production database — expect ~47 rows. Zero rows means no backstop.**

11. **The `entities.js` foreign-key validation gaps.** `assertForeignKeys` (`entities.js:342-350`)
    only validates FK fields listed in each entity's `fk:` map, and several entities
    (`consentRecord`, `feedback`, `testimonial`, `retentionLegalHold`) have no `fk:` key at
    all. I traced the mechanism but did **not** check every `fk:` map against every
    `fields[]` list. Marked SUSPECTED. Not a read leak — rows still land in the attacker's
    own org — but it permits cross-tenant reference grafting and id-existence probing.

12. **Whether any of the 31 skipped tests would fail if run.** They skip on database
    provider, not on failure. I did not stand up Postgres to find out.

---

## What I would fix first, in order

Ordered by (impact × how cheap the fix is), not by severity label alone.

1. **F-3** — swap `subscriptionItems.createUsageRecord` → `billing.meterEvents.create`, and make the failure loud. **You are currently not billing customers at all.** Smallest fix, largest direct revenue impact.
2. **F-2** — copy the ownership check that already exists at `agents.js:100-102` onto the five sibling handlers, key `_cache` by `orgId:id`, and make `run-store.list()` fail closed on a falsy `orgId`. Cross-tenant, returns 200, invisible to error tracking.
3. **F-2b** — add a boot-time assertion that the `tenant_isolation` policy exists when `DATABASE_URL` is Postgres. `rls.sql` is idempotent; this is a few lines and it closes a silent whole-class exposure on three deploy paths.
4. **F-5** — add `requireAnyOrgRole('owner','admin')` to the three billing routes.
5. **F-8** — add `unhandledRejection` / `uncaughtException` handlers.
6. **F-10** — fix the two cookie names in `dsar.js:87-88`.
7. **F-1** — real work. Add the pricing test *first* (with the drift cases above as fixtures), then migrate to integer cents. The test is what makes the migration safe.

F-4 (scopes-are-not-roles) and F-6 (spend accounting) are architectural and each deserve
their own session. F-2c (RAG namespace) is a schema change — worth doing before the
knowledge base holds real customer documents.

**Nothing in this audit was modified. This is a read-only report.**
