# Deploying ScopeCash AI

This platform ships with a single-container Docker image that bundles the
Express API server and the built React dashboard (served as static assets
from the same origin). Both Railway and Fly.io configs are included.

## Required environment variables

| Variable        | Notes                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `JWT_SECRET`    | 32+ char random string. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DATABASE_URL`  | `postgresql://...` — Railway/Fly inject this when you attach Postgres |
| `CORS_ORIGIN`   | Public https URL of your app (e.g. `https://scopecash-ai.fly.dev`) |
| `DIRECT_URL`    | **Required if `DATABASE_URL` is pooled** (PgBouncer/Supabase/Neon pooler). Unpooled direct connection for migrations. |

Optional: `SENTRY_DSN`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `OPENAI_API_KEY`,
`AV_SCAN_URL`, `STORAGE_DRIVER=s3` + S3 credentials.

## Railway

```
railway init                     # pick "Empty Project"
railway add --database postgres  # sets DATABASE_URL
railway variables --set JWT_SECRET=...
railway variables --set CORS_ORIGIN=https://<your-railway-domain>
railway up                       # builds Dockerfile + deploys
```

Railway reads [`railway.json`](railway.json) for the healthcheck path and
start command. Migrations run via `npm run db:postgres:deploy` at boot.

## Fly.io

```
fly launch --no-deploy --copy-config
fly postgres create --name scopecash-ai-db --region iad
fly postgres attach scopecash-ai-db          # sets DATABASE_URL
fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
fly secrets set CORS_ORIGIN=https://scopecash-ai.fly.dev
fly deploy
```

`primary_region = "iad"` (Ashburn, Virginia) is the default for this
US-first product — home-services contractors and their customers are
overwhelmingly US-based. Change to `fra` / `lhr` / `syd` if you have a
specific need to keep a deployment's data in-region for a particular
market. The `[[mounts]]` block reserves `/data` for local uploads; swap
`STORAGE_DRIVER=s3` for production-scale storage.

## Google Cloud Run

For a full infrastructure-as-code path (VPC, private-IP Cloud SQL, Cloud
Storage, Cloud Tasks, Artifact Registry, Secret Manager, IAM), see
[`deploy/terraform-gcp/main.tf`](deploy/terraform-gcp/main.tf) — it
provisions everything below plus the least-privilege service account, and
its Cloud Run env vars are wired directly to the real GCP integration code
in `server/lib/{vertex-ai,storage,cloud-tasks,secret-manager}.js`. Written
against this repo's actual code but not run against a live GCP project —
review the plan output carefully before applying. The manual path below
still works for a quick single-command deploy without provisioning a VPC.

Cloud Run builds the Dockerfile via Cloud Build and runs the container
stateless; use a managed Postgres (Cloud SQL, Neon, or Supabase) and run the
schema setup once from your machine against the production `DATABASE_URL`
(Cloud Run has no pre-deploy hook):

```
# one-time DB setup from your machine (or re-run after schema changes)
cd server
DATABASE_URL="postgresql://..." ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:postgres:deploy

# deploy (from the project root; uses the Dockerfile)
gcloud run deploy scopecash-ai --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,SERVE_DASHBOARD=1,AI_PROVIDER=gemini \
  --set-secrets DATABASE_URL=...,JWT_SECRET=...,ENCRYPTION_KEY=...,ENCRYPTION_SEARCH_KEY=...,GEMINI_API_KEY=...
```

Store secrets in Secret Manager (`gcloud secrets create`) and reference them
with `--set-secrets`. After the first deploy, set `CORS_ORIGIN` to the printed
`*.run.app` URL and redeploy. `AI_PROVIDER=gemini` + `GEMINI_API_KEY` route all
model calls through the Gemini API.

## Local Docker test

```
docker build -t scopecash-ai .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  -e CORS_ORIGIN="http://localhost:8080" \
  scopecash-ai
```

Dashboard: `http://localhost:8080/`  ·  API: `http://localhost:8080/api/health`

## Notes

- The seed creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars
  (default email `admin@example.com`); if `ADMIN_PASSWORD` is unset it generates
  a random password and prints it **once**. In production the seed refuses
  placeholder credentials — set real values before the first deploy.
- `SERVE_DASHBOARD=1` makes the server host the dashboard build. For separate
  front-end deploys (e.g. Vercel + Railway), unset it and deploy `dashboard/build`
  independently, pointing `REACT_APP_API_URL` at the server origin.
- Health endpoints: `/api/health` (detailed), `/api/health/live` (liveness),
  `/api/health/ready` (readiness — respects graceful drain).

