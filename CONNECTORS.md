# Integrations

Pre-wired connectors for this platform. Each runs in **sandbox mode** until its
secrets are set (safe for previews). Configure secrets in the deploy flow.

## Stripe Billing

Subscriptions, usage, and webhooks. Shipped in the saas-platform base (billing feature); formalized here as a selectable connector.

**Environment:**
- `STRIPE_SECRET_KEY` (required) — Stripe secret API key.
- `STRIPE_WEBHOOK_SECRET` (required) — Signing secret for the Stripe webhook endpoint.

## Transactional Email

Send transactional email via Resend or Amazon SES (provider switch).

**Environment:**
- `EMAIL_PROVIDER` — resend | ses (default: resend).
- `EMAIL_FROM` (required) — Verified From address.
- `RESEND_API_KEY` — Resend API key (when EMAIL_PROVIDER=resend).
- `AWS_REGION` — AWS region for SES (when EMAIL_PROVIDER=ses).
- `AWS_ACCESS_KEY_ID` — AWS key for SES.
- `AWS_SECRET_ACCESS_KEY` — AWS secret for SES.

## PostgreSQL (default database)

The default managed database (Prisma). Always present in the base; listed here for the Integrations UI and env docs. Choose the supabase connector for a Supabase-backed Postgres instead.

**Environment:**
- `DATABASE_URL` (required) — Postgres connection string (provisioned automatically by the deploy flow).

## File Storage (S3-compatible)

Object storage on any S3-compatible endpoint (AWS S3, R2, MinIO, Spaces).

**Environment:**
- `S3_BUCKET` (required) — Bucket name.
- `S3_REGION` — Region (default us-east-1).
- `S3_ENDPOINT` — Custom endpoint for non-AWS (R2/MinIO/Spaces).
- `S3_ACCESS_KEY_ID` (required) — Access key id.
- `S3_SECRET_ACCESS_KEY` (required) — Secret access key.

## Outbound Webhooks

POST platform events to any URL, HMAC-signed. Generic, provider-agnostic.

**Environment:**
- `WEBHOOK_SIGNING_SECRET` — HMAC-SHA256 secret used to sign outbound payloads (X-Signature header).

## SMS (Twilio)

Send SMS via Twilio.

**Environment:**
- `TWILIO_ACCOUNT_SID` (required) — Twilio Account SID.
- `TWILIO_AUTH_TOKEN` (required) — Twilio Auth Token.
- `TWILIO_FROM` (required) — Twilio sender phone number (E.164).

