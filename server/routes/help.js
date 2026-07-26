/**
 * Help-centre / docs API (Tier 24).
 *
 *   GET /api/help/articles              — public list (slug, category, title, summary, updated_at)
 *   GET /api/help/articles/:slug        — public single article (full markdown body)
 *   GET /api/help/categories            — public ordered list of categories
 *
 * Content is baked into this module so the help-centre works in air-gapped
 * deployments without touching the filesystem. Updates ship via a normal
 * code release; if you need editor-driven content, swap this for a Prisma
 * model + an admin CRUD route.
 */
const express = require('express');
const { asyncHandler, HttpError } = require('../lib/validate');

const router = express.Router();

const PLATFORM_NAME = 'ScopeCash AI';

const CATEGORIES = [
  { id: 'getting-started', title: 'Getting started',             order: 1 },
  { id: 'evidence',        title: 'Evidence & AI analysis',       order: 2 },
  { id: 'evaluations',     title: 'AI evaluations',               order: 3 },
  { id: 'integrations',    title: 'Integrations & API',           order: 4 },
  { id: 'account',         title: 'Account, billing & teams',     order: 5 },
  { id: 'security',        title: 'Security, privacy & data',     order: 6 },
];

const UPDATED_AT = '2026-07-26';

// Minimal-ceremony article catalogue. Body is markdown; the dashboard ships
// a tiny renderer that handles headings, paragraphs, lists, code, links.
const ARTICLES = [
  {
    slug: 'quickstart',
    category: 'getting-started',
    title: 'Quickstart: from contract to a supported change-order finding',
    summary: 'From signup to your first AI-assisted scope-delta finding with citations, in about ten minutes.',
    body: `
# Quickstart

Welcome to ${PLATFORM_NAME}. This guide takes you from signup to a supported,
citation-backed scope-delta finding on a real project in about ten minutes.

## 1. Create your organization

Registering automatically creates your organization and makes you its
**owner** — there's no separate "create an org" step. Invite teammates
afterward from **Settings → Team** with the right role (project manager,
estimator, field user, or viewer).

## 2. Verify your email

Check your inbox for the verification email and click the link. Some
actions (like enabling MFA) require a verified email first.

## 3. Add a customer and a project

From **Projects**, add the customer and the project (address, trade,
contract value). This is where every document and piece of evidence you
upload will live.

## 4. Upload the contract or estimate

Upload the signed contract or estimate as a source document
(\`document_type: "contract"\` or \`"estimate"\`), then click **Analyze**.
This extracts the baseline scope items and contract provisions — including
page references — that everything else gets compared against.

## 5. Upload field evidence

Upload photos, audio notes, receipts, and messages from the jobsite as
evidence items, then **Analyze** each one. Photos get an AI-generated
description; audio gets transcribed.

## 6. Generate findings

Once you have a baseline and some evidence, click **Generate findings** on
the project. Every finding the AI returns is grounded in at least one
citation pointing at real evidence — a finding with no citation is
discarded automatically, never shown to you as an unsupported guess.

## 7. Review, approve, and export a packet

Review each finding (supported / rejected / pending), then build an
evidence packet for the customer. Packet approval and the commercial
outcome ledger (identified → validated → submitted → approved → invoiced →
collected) are separate, role-gated steps from ordinary editing — so a
packet can't be silently changed to "approved" by accident.

## Next steps

- [How the evidence pipeline works](#help/evidence-pipeline)
- [Inviting team members](#help/inviting-team-members)
- [Connecting Stripe](#help/billing-setup)
`,
  },
  {
    slug: 'inviting-team-members',
    category: 'getting-started',
    title: 'Inviting team members and assigning roles',
    summary: 'Add project managers, estimators, and field crews — with the right least-privilege role.',
    body: `
# Inviting team members

${PLATFORM_NAME} has six roles:

- **owner** — full org control: billing, members, settings, deletion, exports, legal hold, API keys.
- **admin** — manages projects, customers, rate sheets, templates, members, and reporting.
- **project_manager** — creates projects, uploads evidence, reviews findings, approves packets.
- **estimator** — edits scope items, quantities, rates, and proposed pricing.
- **field_user** — uploads photos, voice notes, receipts, and daily logs from the field.
- **viewer** — read-only across projects, findings, and packets.

## Send an invite

1. Open **Settings → Team**.
2. Enter the colleague's email and pick a role.
3. They receive a tokenized invite email valid for 7 days. Accepting it
   creates their membership with exactly the role you chose — nobody can
   grant themselves a different role by accepting a stale link.

## Changing or removing a member

Owners and admins can change a member's role or remove them from
**Settings → Team**. The last remaining owner on an org can't be demoted
or removed — invite a second owner first if you need to step back.
`,
  },
  {
    slug: 'evidence-pipeline',
    category: 'evidence',
    title: 'How the evidence pipeline works',
    summary: 'What the AI actually does with your documents and field evidence, and why every finding has a citation.',
    body: `
# The evidence pipeline

${PLATFORM_NAME}'s AI analysis runs on Gemini via Vertex AI, not a generic
chatbot wrapper. Every call is logged with the exact model version, token
usage, cost, and latency — visible per-project in **Agent activity**.

## Baseline extraction

Uploading a contract or estimate and clicking **Analyze** extracts scope
items and contract provisions with page references — this becomes the
"original scope" everything else is compared against. Nothing is invented:
if the model can't find a quantity or rate explicitly stated in the
document, that field is left blank rather than guessed.

## Field evidence

- **Photos** get a description of what's actually visible, plus a quality
  flag (\`ok\` / \`low_quality\` / \`unreadable\`).
- **Audio** gets transcribed verbatim; unclear portions are marked
  \`[inaudible]\` instead of guessed at.
- **Duplicate photos** (identical content re-uploaded) are recorded, not
  rejected — a field worker photographing the same thing twice is normal,
  and both uploads stay linked via \`duplicateOfId\`.

## Finding generation and mandatory citations

**Generate findings** compares the baseline against all evidence and looks
for four things: scope deltas (work not in the original scope),
contradictions (evidence that conflicts with other evidence), missing
evidence (an assertion nothing else corroborates), and duplicates.

Every finding the model returns must cite specific evidence by name, with
a quoted excerpt. **A finding with no citation is discarded in code before
it's ever saved** — this isn't just a prompt instruction the model could
ignore, it's a hard filter. You will sometimes see fewer findings than you
might expect from a quick read of the evidence; that's the citation
requirement working as intended, not a bug.

## Human review

Every AI-generated finding starts as \`human_decision: "pending"\`. A
project manager marks each one \`supported\`, \`rejected\`, or leaves it
pending with a reason. Rejected findings are never included in a packet.

## Citation validation

Findings and their citations can be checked against the actual cited
evidence's transcript/extracted text — this catches a citation that quotes
something the source doesn't actually contain.
`,
  },
  {
    slug: 'evaluations-overview',
    category: 'evaluations',
    title: 'Running AI evaluations',
    summary: 'Smoke, prompt-injection, and quality suites — what they catch and how to read the results.',
    body: `
# AI evaluations

${PLATFORM_NAME} ships evaluation suites that run fixed test cases against
the configured AI provider and score the results — this is how model
quality and safety regressions get caught before they reach a customer's
evidence packet.

## Running a suite

From **Settings → AI evaluations** (admin only), pick a suite and run it.
Results persist as an \`EvalRun\` with per-case \`EvalResult\` rows, so you
can show quality trends over time.

## What's checked

Beyond a basic smoke suite, evaluation cases specific to contractor
evidence review include: supported vs. unsupported findings, contradictory
evidence preservation, citation validity against actual source spans,
duplicate and missing-timestamp evidence, ambiguous contract clauses,
missing-price/invented-rate refusal, prompt injection embedded inside
uploaded PDFs/DOCX/emails, and rejected findings correctly excluded from
packets.

## Release gate

\`npm run eval\` (server-side) runs the full suite set against the
configured provider and fails the release if any suite drops below its
pass threshold — this is meant to run in CI before a deploy, not just
on-demand from the dashboard.
`,
  },
  {
    slug: 'using-the-rest-api',
    category: 'integrations',
    title: 'Using the REST API',
    summary: 'Authentication, rate limits, the OpenAPI spec, and a curl example.',
    body: `
# Using the REST API

The full OpenAPI spec is available at \`/api/docs\` (Swagger UI) and
\`/api/docs/openapi.json\` (raw JSON).

## Authentication

Two options:

1. **Session cookies** — what the dashboard uses; HttpOnly, SameSite=lax,
   with a rotated refresh token (family-tracked for reuse detection).
2. **API keys** — generated in **Settings → API keys**; pass as
   \`Authorization: Bearer pk_live_...\`. Keys are SHA-256 hashed at rest
   and shown exactly once at creation time.

## Rate limits

- \`/api/auth/*\` — 20 requests / 15 minutes / IP
- Upload endpoints — 30 / minute / IP
- General authenticated endpoints — 600 / minute / token

## Example — upload and analyze a source document

\`\`\`bash
curl -X POST https://your-host/api/projects/PROJECT_ID/sourceDocuments \\
  -H "Authorization: Bearer pk_live_..." \\
  -F "document_type=contract" \\
  -F "file=@contract.pdf"

curl -X POST https://your-host/api/sourceDocuments/DOC_ID/analyze \\
  -H "Authorization: Bearer pk_live_..."
\`\`\`

## Webhooks

Subscribe to project, finding, and packet lifecycle events from
**Settings → Webhooks**.
`,
  },
  {
    slug: 'oauth-apps',
    category: 'integrations',
    title: 'Building an OAuth application',
    summary: 'Three-legged OAuth 2.1 with PKCE for partner integrations.',
    body: `
# OAuth applications

Use OAuth when a partner application needs to act on behalf of one of your
users (e.g. exporting evidence packets to a partner's accounting system).

## Register the app

1. **Settings → Developer → OAuth apps → Create**.
2. Provide a name, homepage URL, and at least one redirect URI.
3. ${PLATFORM_NAME} returns a \`client_id\`. The \`client_secret\` is shown
   exactly once.

## Authorization code with PKCE

1. Direct the user to \`/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=read:projects&code_challenge=...&code_challenge_method=S256\`
2. After consent, exchange the code at \`/oauth/token\` for an access +
   refresh token.

Scopes available: \`read:projects\`, \`write:projects\`, \`read:findings\`,
\`read:packets\`.
`,
  },
  {
    slug: 'billing-setup',
    category: 'account',
    title: 'Connecting Stripe and managing your subscription',
    summary: 'How billing works, what counts toward usage, and how to switch plans.',
    body: `
# Billing & subscriptions

${PLATFORM_NAME} bills monthly via Stripe. The free plan covers a limited
number of active projects and AI analysis calls per month.

## Connect Stripe

Run \`node scripts/stripe-setup.js\` once with your secret key in
\`STRIPE_SECRET_KEY\`. The script provisions the products, prices, and the
billing webhook endpoint at \`/api/billing/webhook\`.

## Switch plans

Open **Settings → Billing → Change plan**. Pro-rated changes apply
immediately; downgrades take effect at the next renewal.

## Usage that counts

- Number of active projects
- AI analysis calls (document extraction, evidence interpretation, finding generation) this month
- Evidence packets generated this month
`,
  },
  {
    slug: 'data-residency-and-export',
    category: 'security',
    title: 'Data residency, retention and export',
    summary: 'Where your data lives, how long we keep it, and how to export it.',
    body: `
# Data residency, retention and export

## Residency

Production hosting and AI processing run in Google Cloud (region
configurable at deployment; see your deployment's specific configuration —
this is not fixed to one region the way a single-region deployment might
suggest). Evidence and documents are stored in the configured object
storage backend for your deployment (Google Cloud Storage, S3-compatible,
or local disk in development).

## Retention

- **Audit log** — retained per your organization's configured retention policy.
- **Evidence and documents** — retained per project until you delete them
  or a legal hold applies.
- **Evaluation results** — 24 months by default; configurable per tenant.
- **Soft-deleted records** — purged after 30 days.

## Legal hold

An owner or admin can place a legal hold on a project, document, or
evidence item, which prevents deletion regardless of retention settings
until the hold is released.

## Export

**Settings → Data → Export** triggers an export bundling your projects,
findings, packets, and audit events into a signed archive, delivered via a
one-time download link emailed to the requesting admin.
`,
  },
  {
    slug: 'incident-response-and-status',
    category: 'security',
    title: 'Incident response and the status page',
    summary: 'How we communicate during incidents and where to find historical uptime.',
    body: `
# Incidents and status

The public **Status** page (linked from the dashboard sidebar) reports:

- Component health (DB, API, worker queue, storage) refreshed every 60s
- 90-day uptime tile bar per component
- SLO grid (latency p95, error budget)
- Active and resolved incidents with timestamps

## Subscribing

Click **Subscribe** on the status page to receive an email when an incident
is opened or resolved.

## Internal incident response

Operators can pause background job processing from the dashboard
(**Operations → Pause**) while investigating an incident.
`,
  },
];

const articleSummaries = ARTICLES.map((a) => ({
  slug: a.slug,
  category: a.category,
  title: a.title,
  summary: a.summary,
  updated_at: UPDATED_AT,
}));

router.get('/categories', asyncHandler(async (_req, res) => {
  res.json({ categories: CATEGORIES });
}));

router.get('/articles', asyncHandler(async (_req, res) => {
  res.json({ articles: articleSummaries, updated_at: UPDATED_AT });
}));

router.get('/articles/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const a = ARTICLES.find((x) => x.slug === slug);
  if (!a) throw new HttpError(404, 'article_not_found');
  res.json({ ...a, updated_at: UPDATED_AT });
}));

module.exports = router;
