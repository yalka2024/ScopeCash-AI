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
  { id: 'getting-started', title: 'Getting started',           order: 1 },
  { id: 'eu-ai-act',       title: 'EU AI Act compliance',      order: 2 },
  { id: 'evaluations',     title: 'AI evaluations',            order: 3 },
  { id: 'integrations',    title: 'Integrations & API',        order: 4 },
  { id: 'account',         title: 'Account, billing & teams',  order: 5 },
  { id: 'security',        title: 'Security, privacy & data',  order: 6 },
];

const UPDATED_AT = '2026-04-20';

// Minimal-ceremony article catalogue. Body is markdown; the dashboard ships
// a tiny renderer that handles headings, paragraphs, lists, code, links.
const ARTICLES = [
  {
    slug: 'quickstart',
    category: 'getting-started',
    title: 'Quickstart: your first compliant AI use case in 10 minutes',
    summary: 'From signup to a defensible Article 6 risk classification with one record on file.',
    body: `
# Quickstart

Welcome to ${PLATFORM_NAME}. This guide takes you from signup to a defensible
Article 6 risk classification with a single AI use case on file in about ten
minutes.

## 1. Create your administrator account

The very first time you load the dashboard, the **first-run setup wizard**
appears. Pick a strong password (12+ characters, upper + lower + digit + symbol),
accept the Terms of Service, and the wizard creates the bootstrap administrator
and your organisation in one step.

## 2. Verify your email

Check your inbox for the verification email and click the link. The dashboard
will mark the *Verify your email* onboarding step complete automatically.

## 3. Add your first AI use case

From the **Dashboard**, click **+ Add record** and supply:

- A short, plain-English description of what the model does
- The intended sector (recruitment, credit, healthcare, etc.)
- The intended decision impact on natural persons

## 4. Run the Article 6 classifier

Open the new record and click **Classify**. The classifier returns a verdict
(prohibited / high / limited / minimal), a score, the obligations that
apply, and citations into Regulation (EU) 2024/1689.

## 5. Generate an Annex IV technical file

Click **Generate Annex IV** to render an audit-ready PDF you can hand to
your conformity assessor. It is hash-chained into the immutable audit log
required by Article 12.

## Next steps

- [Run AI evaluations on the record](#help/evaluations-overview)
- [Invite your compliance lead](#help/inviting-team-members)
- [Plug in your Stripe account](#help/billing-setup)
`,
  },
  {
    slug: 'inviting-team-members',
    category: 'getting-started',
    title: 'Inviting team members and assigning roles',
    summary: 'Add reviewers, auditors, and engineers — with the right least-privilege role.',
    body: `
# Inviting team members

${PLATFORM_NAME} ships three roles out of the box:

- **admin** — full access, including billing, tenants, and audit log retention settings.
- **member** — can create AI use cases, run classifications and evaluations, and acknowledge policies.
- **viewer** — read-only across the dashboard; useful for external auditors.

## Send an invite

1. Open **Settings → Team**.
2. Enter the colleague's email and pick a role.
3. They receive a one-time invite email valid for 7 days.

## Single sign-on

Self-service SSO (SAML, OIDC) is available on the Business plan. See
[OAuth applications](#help/oauth-apps) for OAuth-based integrations.
`,
  },
  {
    slug: 'article-6-classifier',
    category: 'eu-ai-act',
    title: 'How the Article 6 risk classifier works',
    summary: 'Inputs, the rule engine, the verdict structure, and how to defend it in front of a notified body.',
    body: `
# Article 6 risk classifier

The classifier is a deterministic rule engine, **not** a black-box model.
Given six structured inputs — description, sector, decision impact, sensitive
data, deployment scope and provider role — it returns a verdict comprising:

- **risk** — \`prohibited\` | \`high\` | \`limited\` | \`minimal\`
- **score** — 0–100 (how confident the classifier is in the assigned tier)
- **reasoning** — array of bullet points that drove each rule firing
- **obligations** — concrete duties from Articles 9–15, 50, etc.
- **citations** — recital and article numbers in Regulation (EU) 2024/1689

## Inputs that matter most

- **Sector** — Annex III sectors (employment, education, biometric ID,
  essential services, law enforcement) almost always trigger high-risk.
- **Decision impact** — *significant impact on individuals* upgrades the tier.
- **Provider vs deployer role** — drives the obligations list.

## Defending the verdict

Every classification persists to the immutable audit log (Article 12) with
the input snapshot, the rule firings, the model version and the operator's
user ID. Pull the *Annex IV technical file* PDF for a notified-body-ready
narrative.
`,
  },
  {
    slug: 'annex-iv-files',
    category: 'eu-ai-act',
    title: 'Generating and signing Annex IV technical files',
    summary: 'What goes into the PDF, how it is hash-chained, and what to update before each conformity assessment.',
    body: `
# Annex IV technical files

Article 11 + Annex IV require providers of high-risk AI systems to maintain
a technical file before placing the system on the market. ${PLATFORM_NAME}
generates this PDF on demand from the structured fields you maintain on each
AI use case record.

## What's included

1. General description of the AI system (purpose, version, integration)
2. Detailed description of the elements (data, training, validation)
3. Monitoring and logging architecture
4. Risk-management system summary (linked to your evaluation runs)
5. Conformity assessment narrative
6. Post-market monitoring plan

## Hash-chaining

Each generated PDF is hashed (SHA-256) and the hash is appended to the
audit log so a notified body can verify a copy received later is bit-identical.

## Refreshing the file

Re-render the PDF whenever you update the model version, change the data
sources, or after every quarterly review. Old hashes remain in the chain.
`,
  },
  {
    slug: 'evaluations-overview',
    category: 'evaluations',
    title: 'Running AI evaluations',
    summary: 'Bias, robustness, toxicity, prompt-injection and smoke suites — what they catch and how to read the results.',
    body: `
# AI evaluations

${PLATFORM_NAME} ships five evaluation suites out of the box:

| Suite              | What it catches                                  | Cases |
|--------------------|--------------------------------------------------|-------|
| \`smoke\`          | Lightweight sanity check — must always pass     | 4     |
| \`bias_fairness\`  | Article 10 protected-class disparities          | 6     |
| \`robustness\`     | Output stability under semantic rewrites        | 7     |
| \`toxicity\`       | Refusal rate against harmful prompts            | 6     |
| \`prompt_injection\` | Resistance to jailbreak / instruction overrides | 7   |

## Running a suite

Open any AI use case → **Evaluations** card → pick a suite → choose the
invoker (mock for CI, HTTP for live models) → **Run**. The aggregate
admin view at **AI evaluations** (sidebar) shows pass-rate trends across
all records.

## Failure modes

- **0% pass on toxicity / prompt_injection** with the deterministic mock
  invoker is expected — it proves the *scoring* is strict. Wire a real
  HTTP invoker pointing at your model to get meaningful numbers.
- **Sudden drop after a model upgrade** → roll back or harden the system
  prompt before promoting.

## Persistence

Every run persists \`EvalRun\` + per-case \`EvalResult\` rows so you can
prove model-quality drift over time during an audit.
`,
  },
  {
    slug: 'using-the-rest-api',
    category: 'integrations',
    title: 'Using the REST API',
    summary: 'Authentication, rate limits, the OpenAPI spec, and a Python + curl example.',
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

- \`/api/auth/*\` — 10 requests / minute / IP
- \`/api/article6/lead\` and other public marketing endpoints — 10 / min / IP
- General authenticated endpoints — 600 / min / token

## Example — classify an AI use case

\`\`\`bash
curl -X POST https://your-host/api/eu-ai-act/classify \\
  -H "Content-Type: application/json" \\
  -d '{
    "description": "Score CV applications",
    "sector": "employment_or_workers_management",
    "decisionImpact": "significant_impact_on_individuals",
    "dataSensitive": [],
    "scope": "eu_only",
    "providerRole": "deployer"
  }'
\`\`\`

## Webhooks

Subscribe to \`record.classified\`, \`evaluation.completed\` and
\`audit.event\` from **Settings → Webhooks**.
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
users (e.g. exporting Annex IV PDFs to a customer's GRC tool).

## Register the app

1. **Settings → Developer → OAuth apps → Create**.
2. Provide a name, homepage URL, and at least one redirect URI.
3. ${PLATFORM_NAME} returns a \`client_id\`. The \`client_secret\` is shown
   exactly once.

## Authorization code with PKCE

1. Direct the user to \`/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=read:records&code_challenge=...&code_challenge_method=S256\`
2. After consent, exchange the code at \`/oauth/token\` for an access +
   refresh token.

Scopes available: \`read:records\`, \`write:records\`, \`read:evaluations\`,
\`read:annexiv\`.
`,
  },
  {
    slug: 'billing-setup',
    category: 'account',
    title: 'Connecting Stripe and managing your subscription',
    summary: 'How billing works, what counts toward usage, and how to switch plans.',
    body: `
# Billing & subscriptions

${PLATFORM_NAME} bills monthly via Stripe. The free plan covers up to 5 AI
use case records and the smoke evaluation suite.

## Connect Stripe

Run \`node scripts/setup-stripe.js\` once with your secret key in
\`STRIPE_SECRET_KEY\`. The script provisions the products, prices and the
billing webhook endpoint at \`/api/billing/webhook\`.

## Switch plans

Open **Settings → Billing → Change plan**. Pro-rated changes apply
immediately; downgrades take effect at the next renewal.

## Usage that counts

- Number of AI use case records on file
- Annex IV PDF generations this month
- Evaluation runs this month
- Tenants (Business plan only)
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

EU customers' data is hosted in **Frankfurt, Germany**. We do not transfer
production data outside the EEA without an Article 46 GDPR transfer
mechanism.

## Retention

- **Audit log** — 10 years (matches the EU AI Act Article 12 obligation).
- **Annex IV PDFs** — 10 years.
- **Evaluation results** — 24 months by default; configurable per tenant.
- **Soft-deleted records** — purged after 30 days.

## Export

**Settings → Data → Export** triggers a GDPR Article 20 portability
export bundling all your records, evaluations, audit events and Annex IV
PDFs into a signed ZIP. Delivery is via a one-time download link emailed
to the requesting admin.
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

Operators can pause their own AI systems immediately from the dashboard
(**Operations → Pause**) — useful while investigating Article 26 deployer
incidents.
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

