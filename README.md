# ScopeCash AI

AI-operated SaaS platform that helps small specialty contractors document changed scope and unbilled work by comparing original contracts and estimates against jobsite evidence, then producing source-linked, human-reviewed change-order and invoice-support evidence packets with full six-stage monetary outcome tracking.


> **Industry:** home-services
> **Generated** by the platform generator. This is a **working application scaffold**:
> the horizontal infrastructure below is real and production-grade; the
> domain-specific agents, tools, and workflows are **generated stubs wired to a
> generic LLM runtime**. Read [What's real vs. what you must implement](#whats-real-vs-what-you-must-implement)
> before shipping — especially in regulated or safety-critical settings.

---

## Quickstart

```bash
# 1. Server
cd server
cp .env.example .env                 # then set JWT_SECRET (required to boot)
#   generate one: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm install                          # postinstall runs `prisma generate`
npx prisma db push                   # create the SQLite schema (no migrations dir is shipped)
node index.js                        # API on http://localhost:4000

# 2. Dashboard (separate terminal)
cd dashboard
npm install
npm start                            # UI on http://localhost:3000

# 3. Tests
cd server && npm test
```

Defaults to **SQLite** (`file:./dev.db`) so it runs with zero external services.
For Postgres, set `DATABASE_URL` in `.env` (see comments there) and re-run
`npx prisma db push`. Redis is optional in dev (in-memory fallbacks are used).

---

## Architecture

- **Server** — Node/Express, Prisma ORM, JWT auth + refresh tokens, RBAC,
  per-tenant scoping, rate limiting, BullMQ background jobs, structured logging.
- **Dashboard** — React single-page app.
- **AI runtime** — a provider-agnostic tool-calling loop (`server/lib/agent-runtime.js`)
  over Anthropic / OpenAI / Ollama. Agents are declarative definitions; the
  runtime builds a system prompt from each agent and lets the model call tools.
- **Data** — Prisma schema in `server/prisma/schema.prisma`.

### Generated capabilities

**Agents (8)** — declarative definitions under `server/lib/agents/`, auto-loaded by the registry:

- **IntakeAgent** — Identifies document and evidence types, detects duplicate files by SHA-256, flags corrupt, password-protected, or unsupported files, extracts project metadata, and recommends file organization. Never deletes or overwrites original evidence.

- **ScopeBaselineAgent** — Extracts scope items, exclusions, quantities, units, rates, alternates, allowances, change-order procedures, and notice provisions from contracts and estimates. Cites exact page, section, or line for every fact. Flags ambiguity for human review.

- **EvidenceAgent** — Analyzes photographs, audio, PDFs, messages, emails, receipts, and logs using Vertex AI Gemini. Extracts dates, authors, locations, materials, quantities, work descriptions, and directives. Detects duplicate or near-duplicate images. Flags missing timestamp or location metadata. Never infers work occurred solely from object presence.

- **ScopeDeltaAgent** — Compares validated field evidence against the original-scope baseline to identify possible added, omitted, substituted, accelerated, or repeated work. Cites both baseline and field evidence. Presents uncertainty. Avoids any legal-entitlement conclusions.

- **PricingAgent** — Calculates cost items using only organization rate sheets, contract rates, uploaded supplier invoices, validated labor records, or reviewer-entered rates. Shows every calculation. Applies configured markup and tax transparently. Never invents market rates. Flags missing prices instead of estimating without authorization.

- **ProofAndRiskAgent** — Challenges every proposed finding, surfaces contradictory documents, identifies missing dates, directives, quantities, prices, signatures, and causal links. Detects unsupported or duplicated charges. Marks high-risk assertions. Blocks packet approval when critical evidence is missing unless an authorized reviewer explicitly accepts and documents the risk.

- **PacketAgent** — Generates versioned, professional evidence packets containing cover page, project info, executive summary, baseline, change event descriptions, timeline, cost breakdown, source-linked evidence, provision references, photographic appendix, document appendix, assumptions, unresolved questions, human approval record, and attorney-reviewed disclaimer. Requires human approval before finalization.

- **BusinessOperationsAgent** — Monitors leads, onboarding, paid audits, subscriptions, agent usage, and Gemini and infrastructure costs. Produces competition evidence reports. Strictly separates the six monetary stages: identified, validated, submitted, approved, invoiced, collected. Never inflates or merges these figures. Distinguishes arms-length from related-party revenue.



**Tools (12)** — under `server/lib/tools/`. Each is an **adapter**: it runs on **labeled mock data** by default (results tagged `_mock: true`); set `INTEGRATION_<NAME>_MODE=live` and implement `realRun()` to connect the real system. In live mode an unimplemented integration **refuses** rather than fake it. Live/mock status is at `/api/health/integrations`:

- **VertexAIGeminiClient** — Multimodal Gemini API wrapper for document extraction, image interpretation, audio transcription, scope comparison, and packet drafting. Records model version, token usage, latency, cost, and citations per call.

- **CloudStorageClient** — Immutable evidence store with signed URL generation, path validation, and no public exposure.

- **CloudTasksEnqueuer** — Durable async job queue for all agent runs, file processing, PDF rendering, email delivery, and retention jobs.

- **SHA256Hasher** — Computes SHA-256 hash of uploaded file bytes for duplicate detection and immutability verification.

- **MalwareScanHook** — Pre-storage file inspection integration point. Fails upload pipeline if scan result is non-clean.

- **PDFPacketRenderer** — Server-side PDF generation for evidence packets using WeasyPrint or Puppeteer. Embeds disclaimer, source appendix, and approval record.

- **StripeClient** — Checkout session creation, subscription management, idempotent webhook handling, invoice retrieval, and billing state sync.

- **AuditLogWriter** — Appends immutable structured audit events for every sensitive platform action with org ID, user ID, action type, resource ID, and timestamp.

- **TOTPMFAProvider** — TOTP-based MFA enrollment, challenge, and verification for all user accounts.

- **SecretManagerClient** — Reads all production credentials from Google Secret Manager at runtime. No secrets in environment files or source code.

- **EmailNotificationSender** — Sends transactional notifications via SES or SendGrid. Human-approved outbound commercial emails only. Supports upload-complete, analysis-complete, finding-review, packet-ready, and payment notifications.

- **OpenAPISpecExporter** — Generates and serves self-documenting OpenAPI 3.1 spec for all REST API endpoints with pagination, tenant scoping, and stable error formats.



**Workflows (7)** — step definitions under `server/lib/workflows/`:

- **OrgOnboarding** — New contractor organization setup from creation through first project.

- **PaidProjectAudit** — End-to-end paid audit from Stripe Checkout through packet delivery and feedback.

- **EvidenceIngestion** — Secure, validated, immutable upload pipeline with async Gemini processing.

- **FindingReview** — Structured human review of every AI-generated evidence finding.

- **PacketApproval** — Controlled human approval and export of the evidence packet.

- **OutcomeTracking** — Six-stage monetary outcome recording with funnel visualization.

- **CustomerFeedback** — Post-delivery feedback and consented testimonial collection.



---

## What's real vs. what you must implement

**Real and production-grade (horizontal infrastructure):**
- Authentication (JWT + refresh, login lockout), RBAC, per-tenant data scoping
- Tamper-evident audit log (hash-chained), AI guardrails (PII redaction,
  injection detection, token budgets), rate limiting, scoped API keys
- Health/readiness probes, graceful shutdown, Docker + deploy configs
- The generic LLM agent/tool/workflow runtime

**Generated scaffolding — implement before relying on it:**
- **Agent logic.** Each agent is a name/role/description/inputs/outputs
  definition with **no domain algorithm**. The "intelligence" is whatever the
  configured LLM does with that prompt. Anything requiring real math, models, or
  deterministic rules (forecasting, scoring, validation) must be written by you.
- **Integration tools run on mock data.** Every external integration (EHR/FHIR,
  supplier APIs, payment rails, data feeds, etc.) ships as an **adapter** with a
  working mock (results tagged `_mock: true`) and an empty `realRun()`. There are
  **no real network calls** to third-party systems until you implement `realRun()`
  and switch that tool to `live`. In live mode an unimplemented adapter throws —
  it never returns a fake result dressed as real.
- **Domain data model.** The Prisma schema models generic SaaS entities plus a
  single document-style `project` record. Domain tables you need
  (inventory, transactions, domain-specific records) are **not** present — add them.
- **Domain analytics/KPIs.** Dashboards render generic platform pages; replace
  them with your real domain views and metrics.

⚠️ **Do not deploy this into a regulated, financial, or safety-critical workflow
on the assumption that the domain features work.** They are scaffolds. Treat the
LLM outputs as suggestions, not authoritative results, until backed by real
data sources and validated logic.

---

## Project layout

```
ScopeCash AI/
├── server/              # Express API, Prisma, auth, jobs, AI runtime
│   ├── index.js         # entrypoint
│   ├── prisma/          # schema.prisma
│   ├── routes/          # HTTP routes
│   ├── lib/
│   │   ├── agents/      # generated agent definitions
│   │   ├── tools/       # generated tools (integration tools are stubs)
│   │   └── workflows/   # generated workflow definitions
│   └── tests/           # jest unit + integration tests
├── dashboard/           # React app
├── Dockerfile           # single-container build (API + built dashboard)
└── DEPLOY.md            # deployment guide
```

## Deployment

See [DEPLOY.md](./DEPLOY.md). The Dockerfile builds the dashboard and serves it
from the API (`SERVE_DASHBOARD=1`) for a single-container deploy. Set
`JWT_SECRET`, `ENCRYPTION_KEY`, and `ENCRYPTION_SEARCH_KEY` (see `.env.example`)
in any non-dev environment — the server refuses to start in production without them.

