# Environment variable inventory — ScopeCash AI

Single source of truth for every environment variable read by the
ScopeCash AI server, dashboard, and worker. **Required** vars
must be set or the server refuses to boot. **Recommended** vars
should be set for any non-trivial production deployment. **Optional**
vars enable specific features.

For local dev, copy `server/env.example` → `server/.env` and fill
the **Required** block.

---

## Server runtime

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `NODE_ENV` | enum | `development` | recommended | `production` enables Sentry, prod CSP, Secure cookies |
| `PORT` | int | `4000` | optional | TCP port for the API server |
| `PUBLIC_URL` | URL | — | recommended | Public origin used in webhooks, emails, OAuth redirects |
| `PUBLIC_DASHBOARD_URL` | URL | — | recommended | Public dashboard origin (Stripe portal return URL, etc.) |
| `CORS_ORIGIN` | csv | `http://localhost:3000` | required | Comma-separated allowed origins |
| `SERVE_DASHBOARD` | bool | `0` | optional | `1` = single-container deploy (server hosts dashboard build) |
| `BUILD_TIME` | ISO-8601 | — | optional | Image build timestamp surfaced in `/api/health` |
| `GIT_SHA` | string | — | recommended | Commit SHA surfaced in `/api/health` and Sentry releases |
| `BETA_MODE` | bool | `0` | optional | Surfaces beta banner in dashboard |
| `CSP_DISABLED` | bool | `0` | optional | **Local debugging only.** Disables Content Security Policy |
| `SHUTDOWN_TIMEOUT_MS` | int | `25000` | optional | Soft drain budget on SIGTERM |
| `SHUTDOWN_HARD_TIMEOUT_MS` | int | `40000` | optional | Hard exit budget after soft drain |

## Authentication & sessions

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `JWT_SECRET` | string ≥32 chars | — | **required** | Signs access JWTs. Server refuses to boot with placeholder/short value |
| `ACCESS_TOKEN_TTL` | duration | `15m` | optional | Access JWT lifetime (`15m`, `1h`, etc.) |
| `REFRESH_TOKEN_TTL_DAYS` | int | `14` | optional | Refresh-cookie lifetime in days |
| `LOGIN_MAX_FAILED` | int | `8` | optional | Failed-login threshold before lockout |
| `LOGIN_LOCK_MINUTES` | int | `15` | optional | Lockout duration after threshold |
| `ADMIN_EMAIL` | email | `admin@demo.local` | optional (legacy) | Bootstrap admin email if seed runs *before* setup wizard |
| `ADMIN_PASSWORD` | string | `demo-admin-2026` | optional (legacy) | Replaced by first-run setup wizard |
| `DEFAULT_ORG_NAME` | string | `ScopeCash AI` | optional | Default org name for legacy seeding |
| `ONBOARDING_STEPS` | csv | (built-in) | optional | Override the onboarding-step ordering |

## Database, cache, queue

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `DATABASE_URL` | URL | `file:./dev.db` | **required (prod)** | SQLite for dev, Postgres for prod |
| `DIRECT_URL` | URL | — | required iff `DATABASE_URL` is pooled | Unpooled Postgres URL for migrations |
| `REDIS_URL` | URL | — | recommended | Enables distributed rate-limit, job queue, sessions |
| `CACHE_DEFAULT_TTL` | int (s) | `60` | optional | Default cache TTL |
| `WORKER_CONCURRENCY` | int | `4` | optional | BullMQ worker parallelism |

## Object storage

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `STORAGE_DRIVER` | enum `local` \| `s3` | `local` | recommended | `s3` is required for L4 (DATA-002) |
| `STORAGE_BUCKET` | string | — | required iff `s3` | Bucket name |
| `STORAGE_REGION` | string | — | required iff `s3` | AWS region |
| `STORAGE_ENDPOINT` | URL | — | optional | Override for R2 / MinIO / on-prem S3 |
| `STORAGE_ACCESS_KEY_ID` | string | — | required iff `s3` and not using IRSA | S3 access key |
| `STORAGE_SECRET_ACCESS_KEY` | string | — | required iff `s3` and not using IRSA | S3 secret key |
| `STORAGE_LOCAL_DIR` | path | `./uploads` | optional | Local-mode upload root |
| `UPLOAD_MAX_BYTES` | int | `20971520` (20 MiB) | optional | Per-file upload cap |
| `AV_SCAN_URL` | URL | — | recommended | ClamAV scanner endpoint |
| `AV_FAIL_OPEN` | bool | `0` | optional | `1` = allow uploads if AV is down |

## Email

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `EMAIL_FROM` | email | `no-reply@example.com` | recommended | From address |
| `EMAIL_REPLY_TO` | email | — | optional | Reply-to address |
| `EMAIL_TO` | email | — | optional | Default test-target for `email:test` script |
| `RESEND_API_KEY` | string | — | optional (preferred) | Resend API key (preferred provider) |
| `SENDGRID_API_KEY` | string | — | optional | SendGrid API key (fallback provider) |
| `SENDGRID_FROM` | email | — | optional | Verified sender for SendGrid |
| `SUPPORT_EMAIL` | email | `support@scopecash-ai.app` | recommended | Surfaced in dashboard help-centre footer |

## AI providers

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `AI_PROVIDER` | enum `openai`\|`anthropic`\|`auto` | `auto` | optional | Routing strategy default |
| `AI_ROUTER_STRATEGY` | enum | `auto` | optional | `auto`/`primary-only`/`fallback-only` |
| `AI_DAILY_TOKEN_LIMIT` | int | `200000` | optional | Per-org daily token cap |
| `AI_MAX_INPUT_CHARS` | int | `8000` | optional | Per-prompt input cap |
| `OPENAI_API_KEY` | string | — | optional | OpenAI key |
| `OPENAI_MODEL` | string | `gpt-4o-mini` | optional | Default OpenAI model |
| `ANTHROPIC_API_KEY` | string | — | optional | Anthropic key |
| `ANTHROPIC_MODEL` | string | `claude-3-5-sonnet-latest` | optional | Default Anthropic model |

## Stripe billing

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `STRIPE_SECRET_KEY` | string | — | required iff billing enabled | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | string | — | required iff billing enabled | `whsec_...` |
| `BILLING_AGGREGATOR_DISABLED` | bool | `0` | optional | Disable usage-aggregation cron |
| `BILLING_GRACE_DAYS` | int | `7` | optional | Days past-due before suspension warnings |
| `BILLING_SUSPEND_DAYS` | int | `14` | optional | Days past-due before suspension |
| `STRIPE_PRICE_STARTER` | string | — | required iff billing | Stripe price ID for Starter plan |
| `STRIPE_PRICE_PRO` | string | — | required iff billing | Stripe price ID for Pro plan |
| `STRIPE_PRICE_ENTERPRISE` | string | — | required iff billing | Stripe price ID for Enterprise plan |

## Backups & warehouse

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `BACKUP_DESTINATION` | URL | — | required for prod backups | `s3://bucket/path` or `gs://...` |
| `BACKUP_RETENTION_DAYS` | int | `30` | optional | Backup pruning threshold |
| `WAREHOUSE_EXPORT_CRON_MS` | int | — | optional | Periodic warehouse-export interval |
| `WAREHOUSE_EXPORT_DIR` | path | — | optional | Local export root |
| `WAREHOUSE_EXPORT_RETAIN_DAYS` | int | `30` | optional | Warehouse-export retention |

## Trust kits

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `AUTO_APPROVE_TRUST_KITS` | bool | `0` | optional | Skip manual approval (dev only) |
| `TRUST_KIT_MAX_DOWNLOADS` | int | `25` | optional | Per-kit download cap |
| `TRUST_KIT_TTL_DAYS` | int | `7` | optional | Kit link lifetime |

## Observability

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `SENTRY_DSN` | URL | — | recommended | Crash reporting |
| `SENTRY_RELEASE` | string | `GIT_SHA` | optional | Release name for Sentry |
| `SENTRY_SEND_PII` | bool | `0` | optional | Send userId/email to Sentry |
| `SENTRY_TRACES_SAMPLE_RATE` | float | `0.1` | optional | Performance sample rate |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | URL | — | recommended | OTLP collector endpoint |
| `SLO_DEFINITIONS` | path | (built-in) | optional | Override path to SLO definitions JSON |

## Dashboard build-time

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `REACT_APP_API_URL` | URL | `/api` | recommended | Baked into the dashboard bundle. Must end in `/api` |

---

## Secret-class summary

Variables in **bold** below are *secrets* and must be sourced from a
vault / KMS in production (never committed, never logged):

> **`JWT_SECRET`**, **`DATABASE_URL`** (contains password),
> **`DIRECT_URL`**, **`REDIS_URL`** (often contains auth),
> **`STORAGE_ACCESS_KEY_ID`** + **`STORAGE_SECRET_ACCESS_KEY`**,
> **`STRIPE_SECRET_KEY`**, **`STRIPE_WEBHOOK_SECRET`**,
> **`OPENAI_API_KEY`**, **`ANTHROPIC_API_KEY`**,
> **`SENDGRID_API_KEY`**, **`RESEND_API_KEY`**,
> **`SENTRY_DSN`** (contains project token).

Rotation cadence and procedure for each is defined in
[`SECRETS-ROTATION.md`](./SECRETS-ROTATION.md).

---

## Validation

Run `node server/scripts/validate-env.js` (when present) or simply
boot the server and watch for `[startup]` warnings — every variable
the server expected is logged with its source (`env`, `secret`, or
`default`).

