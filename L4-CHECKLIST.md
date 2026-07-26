# Level 4 Enterprise Readiness Checklist — ScopeCash AI

This file is generated automatically. Run `pwsh ops/l4-audit.ps1` (or
`bash ops/l4-audit.sh`) to produce a fresh `l4-attestation.json` with the
current pass/fail state for each control.

The L4 maturity model used here covers eight pillars. Every control must
be `pass` (or explicitly `accepted` with a justification) before the
platform is fit for an enterprise customer in a regulated vertical.

## 1. Identity, access & secrets

- [ ] **AUTH-001** No placeholder `JWT_SECRET` in any deployed env (≥ 32 chars random).
- [ ] **AUTH-002** Refresh tokens rotate on every use; revoked tokens denied within 60 s.
- [ ] **AUTH-003** TOTP MFA available for every user role; required for `admin`.
- [ ] **AUTH-004** Password policy enforced (min 12 chars, blocked common-password list).
- [ ] **IAM-001**  Cookie sessions use `Secure`, `HttpOnly`, `SameSite=Strict` in prod.
- [ ] **IAM-002**  CSRF double-submit token enforced on every state-changing route.
- [ ] **SEC-001**  Secrets sourced exclusively from a vault / KMS — never committed.
- [ ] **SEC-002**  All API keys hashed at rest; only prefix shown to operators.

## 2. Data protection & multi-tenancy

- [ ] **DATA-001** Every tenant-scoped query filters by `organizationId` (no leak paths).
- [ ] **DATA-002** Storage backend is S3 (or equivalent) with SSE + versioning + MFA-delete.
- [ ] **DATA-003** Encryption in transit: TLS 1.2+ enforced on every public endpoint.
- [ ] **DATA-004** Database is Postgres ≥ 14 with TLS, automated daily encrypted backups,
                   and a verified restore runbook (see `ops/backup/pg-restore.sh`).
- [ ] **DATA-005** PII fields documented in `data-classification.json`, with retention.
- [ ] **DATA-006** Right-to-erasure / DSAR workflow exists and is tested.

## 3. Reliability, scale & DR

- [ ] **REL-001**  `/api/health/live` and `/api/health/ready` return correct semantics.
- [ ] **REL-002**  Graceful shutdown drains in-flight requests within `SHUTDOWN_TIMEOUT_MS`.
- [ ] **REL-003**  Background jobs use a durable queue (BullMQ on Redis) — not in-process FIFO in prod.
- [ ] **REL-004**  Two replicas of the API in production with rolling-update strategy.
- [ ] **REL-005**  Database backups: daily, encrypted, off-region, retention ≥ 30 days.
- [ ] **DR-001**   Documented RPO and RTO; restore drill performed in last 90 days.

## 4. Observability

- [ ] **OBS-001**  Structured JSON access log on every request with `requestId`.
- [ ] **OBS-002**  OTel traces shipped to a collector (`OTEL_EXPORTER_OTLP_ENDPOINT` set).
- [ ] **OBS-003**  Prometheus `/metrics` scraped; alert rules for error rate, p95, queue depth.
- [ ] **OBS-004**  Sentry (or equivalent) DSN configured for unhandled exceptions.
- [ ] **OBS-005**  Audit log is append-only with hash chaining; export for SIEM available.

## 5. Supply chain

- [ ] **SUP-001**  Container images built reproducibly; pinned base image digest.
- [ ] **SUP-002**  SBOM (SPDX) generated and attached to each image release.
- [ ] **SUP-003**  Images signed via cosign; deploy gate enforces signature verification.
- [ ] **SUP-004**  Vulnerability scan (grype/trivy) gates the release pipeline at `high`.
- [ ] **SUP-005**  Dependencies pinned via lockfile; Dependabot/Renovate enabled.

## 6. CI/CD & change management

- [ ] **CI-001**   All merges require ≥ 1 reviewer + green test suite.
- [ ] **CI-002**   Migrations applied via `prisma migrate deploy` only; no destructive auto-rollback.
- [ ] **CI-003**   Production deploys are auditable (commit SHA in `/api/health/ready` or `/version`).
- [ ] **CI-004**   Feature flags / kill switches available for risky rollouts.

## 7. Privacy, legal & contractual

- [ ] **PRIV-001** DPA template exists and covers controller / processor terms.
- [ ] **PRIV-002** Sub-processor list maintained; customers notified before changes.
- [ ] **PRIV-003** Cookie / consent banner present in the dashboard for EU users.
- [ ] **PRIV-004** Data residency option documented (regional DB / storage).

## 8. UX, accessibility & i18n

- [ ] **UX-001**   Dashboard passes axe-core scan with no `serious`/`critical` findings.
- [ ] **UX-002**   Skip-to-content link, focus rings, and `prefers-reduced-motion` honored.
- [ ] **UX-003**   At least one non-English locale available; `<html lang>` set per session.
- [ ] **UX-004**   Forms expose accessible labels and error messages.

---

When all controls are `pass` (or accepted), commit the resulting
`l4-attestation.json` to your audit evidence repository.

