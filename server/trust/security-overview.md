# ScopeCash AI — Security Overview

> Generated artifact. For the most current version visit `/trust` on your tenant.

## Architecture
- **Web tier:** Express 5 on Node 20 LTS, behind a reverse proxy with TLS termination at the edge.
- **API tier:** Same process; rate-limited per-IP and per-API-key.
- **Background workers:** BullMQ on Redis for async/scheduled work (webhook delivery, usage aggregation, dunning sweep).
- **Persistence:** PostgreSQL (production) via Prisma; better-sqlite3 supported for development & demos only.
- **Object storage:** Pluggable driver (`local` for dev, `s3` for production).

## Identity & Access
- Cookie sessions on the dashboard, JWT (15-minute access, 14-day refresh) for the API.
- MFA (TOTP) supported and enforced on admin roles.
- API keys are hashed at rest; only the prefix is shown after issue.
- CSRF cookie issued on every request, enforced on unsafe methods (excluded for `Authorization: Bearer` and `x-api-key`).

## Cryptography
- TLS 1.2+ end-to-end (HSTS preloaded).
- AES-256 at rest (managed by storage backend).
- Secrets fail-closed: boot refuses to start with placeholder `JWT_SECRET` or with SQLite `DATABASE_URL` in production.

## Audit & Logging
- Structured JSON access logs with `requestId` correlation header (`x-request-id`).
- Append-only `Activity` table for security-relevant events (login, MFA toggle, admin action, data export).
- Webhook deliveries persisted with attempt history and signed payloads.

## Vulnerability Management
- Daily Dependabot alerts; weekly grype scan in CI.
- Container images SBOM'd (CycloneDX/SPDX) and signed via cosign keyless (Sigstore).
- SLSA Build Level 3 provenance attestations.

## Data Protection
- DSR endpoints under `/api/privacy/dsr` (access, erasure, portability).
- Tenant data isolated by `orgId`; row-level filters enforced by middleware.
- 30-day deletion SLA; cryptographic erasure on backups within 90 days.

## Incident Response
- 24×7 paging via on-call rotation.
- Customer notification within 72 hours of confirmed personal-data breach.
- Postmortem published within 14 days for any P0/P1 customer-impacting event.

## Reporting Vulnerabilities
Email `security@scopecash-ai.example` (PGP key on `/trust/pgp.asc`). 90-day coordinated disclosure.

