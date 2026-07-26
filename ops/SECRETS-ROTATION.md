# Secrets rotation runbook — ScopeCash AI

This runbook documents the **how, when, and who** of rotating every
secret used by ScopeCash AI in production. Quarterly rotation of
all long-lived secrets is required for L4 enterprise compliance. After
each rotation, append an entry to `ops/secrets-rotation.log` and
re-run `pwsh ops/l4-audit.ps1`.

> **Golden rule:** every secret listed here must be sourced from a vault
> or KMS in production (Hashicorp Vault, AWS Secrets Manager, GCP Secret
> Manager, or sealed-secrets in k8s). **Never** commit `.env` files or
> store production secrets in CI environment variables outside the
> secrets store.

---

## Routine cadence

| Secret class                | Cadence       | Owner            |
| --------------------------- | ------------- | ---------------- |
| `JWT_SECRET`                | 90 days       | Platform team    |
| `DATABASE_URL` password     | 90 days       | DBA              |
| `REDIS_URL` password        | 90 days       | Platform team    |
| Object-storage credentials  | 90 days       | Platform team    |
| `STRIPE_SECRET_KEY`         | 180 days      | Billing owner    |
| `STRIPE_WEBHOOK_SECRET`     | 180 days      | Billing owner    |
| OAuth provider client secrets | 180 days    | Auth owner       |
| Email provider API key      | 180 days      | Comms owner      |
| AI provider API keys        | 180 days      | AI owner         |
| Sentry/OTel ingest tokens   | 365 days      | SRE              |
| Internal API keys (per user) | On demand    | API key owner    |
| TLS certificates            | 60 days (auto via cert-manager) | SRE |

Force a rotation **immediately** if any of the following are true:

- A team member with secret access has off-boarded
- A secret has been logged or echoed in plaintext anywhere
- A dependency CVE indicates upstream credential exposure
- A vendor's security bulletin requests rotation

---

## 1. `JWT_SECRET` (zero-downtime)

The server refuses to start if `JWT_SECRET` is shorter than 32
characters or matches a known placeholder. Existing access tokens
(15-minute TTL) become invalid immediately on rotation; refresh
tokens are still honoured against the new secret because the
hashed refresh token is stored in `RefreshToken`, not the JWT.

```bash
# 1. Generate a fresh secret
NEW=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# 2. Push to vault / Helm secret
kubectl create secret generic scopecash-ai-server \
  --from-literal=JWT_SECRET="$NEW" \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. Rolling restart (no traffic loss with 2+ replicas)
kubectl rollout restart deployment/scopecash-ai-server
kubectl rollout status  deployment/scopecash-ai-server

# 4. Audit log entry
echo "$(date -u +%FT%TZ),JWT_SECRET,$USER" >> ops/secrets-rotation.log
```

Users will see one extra "session expired" prompt; sessions resume
once the dashboard re-issues an access token via the refresh cookie.

---

## 2. `DATABASE_URL` password (zero-downtime)

For managed Postgres (RDS / Cloud SQL / Neon / Supabase), use the
provider's "rotate credentials" feature. For self-managed Postgres:

```bash
# 1. Pick a new password & ALTER ROLE
NEW=$(openssl rand -base64 32)
psql "$DATABASE_URL" -c "ALTER ROLE app WITH PASSWORD '$NEW';"

# 2. Update the secret with the new connection string
NEW_URL="postgresql://app:$NEW@db:5432/scopecash-ai?sslmode=require"
kubectl create secret generic scopecash-ai-server \
  --from-literal=DATABASE_URL="$NEW_URL" \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. Rolling restart
kubectl rollout restart deployment/scopecash-ai-server
kubectl rollout restart deployment/scopecash-ai-worker
```

`DIRECT_URL` (when using a pooled connection) must be rotated in
the same step.

---

## 3. Object-storage credentials (S3 / R2 / GCS)

Best practice: use IRSA (EKS) or workload identity (GKE) so no
static credentials ever exist. If you must use `STORAGE_ACCESS_KEY_ID`
+ `STORAGE_SECRET_ACCESS_KEY`:

1. In your storage console, create a *new* access key for the
   service IAM user (do **not** delete the old key yet).
2. Push both keys into the secret simultaneously? **No** — the env
   var only takes one. Use the dual-secret approach:
   - Roll out the new key.
   - Wait for `kubectl rollout status` to complete on `server` and
     `worker`.
   - **Then** delete the old key in the storage console.
3. Verify the next presign succeeds via the dashboard upload flow
   (or `curl` test in `ops/smoke/upload.sh`).

---

## 4. Stripe live keys

Stripe rolling-key rotation:

```bash
# 1. In the Stripe Dashboard → Developers → API keys, click "Roll key"
#    on the live secret key. Stripe issues a new sk_live_...

# 2. Update the webhook signing secret (Developers → Webhooks)
#    if the previous one is being decommissioned.

# 3. Push both values to the secret
kubectl create secret generic scopecash-ai-server \
  --from-literal=STRIPE_SECRET_KEY=sk_live_... \
  --from-literal=STRIPE_WEBHOOK_SECRET=whsec_... \
  --dry-run=client -o yaml | kubectl apply -f -

# 4. Rolling restart, then smoke-test:
#    a) /api/billing/portal returns a session URL
#    b) trigger a Stripe test webhook → /api/billing/webhook returns 200
```

---

## 5. OAuth provider client secrets

For each registered OAuth app (Google, Microsoft, GitHub):

1. In the provider's developer console, generate a new client
   secret and copy the value.
2. Update the platform secret keyed `OAUTH_<PROVIDER>_CLIENT_SECRET`.
3. Rolling restart.
4. Sign in with each provider to confirm.
5. **Within 24 hours**, revoke the old client secret in the provider
   console. (Some providers, e.g. Google, allow two active secrets
   simultaneously which makes this overlap safe.)

---

## 6. Email provider (Resend / SendGrid)

```bash
# 1. Generate a new API key in the provider dashboard with the same
#    scopes (Send-only).
# 2. Update + restart, exactly as JWT_SECRET above.
# 3. Send a test email via:
#    npm run email:test
# 4. Revoke old key.
```

---

## 7. Internal user API keys

User-issued API keys (Settings → API keys) are SHA-256 hashed at rest
and shown to the operator only at creation time. Operators should
rotate any key that:

- Has been pasted into a chat or screenshot
- Is held by a third-party integration that's being deprecated
- Has produced unexpected `403`/rate-limit traffic in the audit log

**Procedure:** create a new key first, swap the consumer, **then**
revoke the old key from the dashboard. Revoking is instant —
blacklist propagates within 1 second via Redis.

---

## 8. TLS certificates

Managed by `cert-manager` with the `letsencrypt-prod` ClusterIssuer.
Renewal runs automatically every 60 days. Validate manually before
any planned production change:

```bash
kubectl get certificate -n scopecash-ai
kubectl describe certificate scopecash-ai-tls -n scopecash-ai | tail -20
```

If a renewal is failing (typically DNS-01 challenge issues), the
runbook is in `ops/runbooks/tls-renewal-failure.md`.

---

## Verification after rotation

1. `pwsh ops/l4-audit.ps1` — confirm no controls regressed.
2. `node ops/smoke/post-rotation.js` — exercises auth, billing,
   email, storage, AI, and webhook delivery.
3. Append to `ops/secrets-rotation.log`:
   ```
   2026-04-20T09:14:00Z,JWT_SECRET,alice
   ```
4. Open a `secret-rotation` Sentry release marker so any auth-related
   error spike post-rotation is correlated.

---

## Annual / triennial duties

- **Annually:** review who has `kubectl get secret` permission;
  re-justify each holder.
- **Annually:** confirm KMS key rotation policy is enabled
  (AWS KMS: 365-day automatic rotation).
- **Triennially:** rotate the long-lived encryption-at-rest key
  (`SECRET_ENCRYPTION_KEY`) by re-encrypting all encrypted columns.
  Procedure in `ops/runbooks/data-key-rotation.md`.

