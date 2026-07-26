# Backup/restore DR drill — results

Real drill, executed 2026-07-26 against a dedicated, disposable Postgres 16
container (not shared with any other environment) — not a paper exercise.
Methodology, findings, and the numbers this repo can currently back with a
real measurement are below. Re-run this drill (steps at the bottom) whenever
`ops/Dockerfile`, `ops/backup/pg-*.sh`, or `server/scripts/db-*.js` change, or
at minimum before every quarter's on-call handoff.

## What was actually run

1. Started a throwaway `postgres:16` container (matching this repo's real
   deploy targets — `docker-compose.yml`'s `postgres:16` and
   `deploy/terraform-gcp/main.tf`'s `database_version = "POSTGRES_16"`).
2. Applied real migrations (`prisma migrate deploy --config
   prisma.postgres.config.ts`) and seeded it — first with the existing demo
   dataset (`prisma/seed-riverside-demo.js`), then with 50,000 synthetic rows
   (`GrowthEvent`) to get past toy-database-sized numbers → 26 MB database.
3. Ran the actual backup mechanism the Helm `CronJob`
   (`deploy/helm/templates/backup-cronjob.yaml`) invokes in production:
   `ops/backup/pg-backup.sh`, inside a real container image built from
   `ops/Dockerfile`.
4. Simulated a real disaster: `DROP DATABASE` + `CREATE DATABASE` (not a
   truncate — full, genuine data loss, same blast radius as losing the
   underlying disk).
5. Ran the actual restore mechanism, `ops/backup/pg-restore.sh`, from the
   backup produced in step 3.
6. Verified data integrity: exact row-count match across all 71 tables,
   pre-backup vs. post-restore (`SELECT count(*)` per table, diffed).

## Real bugs found and fixed by running this for real

Nothing here was known or suspected beforehand — all three surfaced only
because the mechanism was actually exercised rather than read:

1. **`ops/backup/pg-backup.sh` breaks in any Linux container when built on
   a normally-configured Windows machine.** The committed blob is pure LF
   (verified via `git cat-file`) — but with no `.gitattributes` to say so,
   a checkout on Windows with `core.autocrlf=true` (the setting Git for
   Windows' own installer recommends by default) silently rewrites it to
   CRLF on disk. `docker build`'s `COPY` reads that real, checked-out file,
   so the CRLF shebang (`#!/usr/bin/env bash\r`) fails as
   `bash\r: No such file or directory` — this repo's own development
   machine hit exactly that building `ops/Dockerfile` for this drill, and
   any Windows CI runner or developer would hit the same thing. **Fixed**:
   added `.gitattributes` (`*.sh text eol=lf`) so checkout is forced to LF
   for these paths regardless of the local `core.autocrlf` setting.
2. **`ops/Dockerfile` — referenced by `backup-cronjob.yaml` as
   `ghcr.io/your-org/scopecash-ai-ops:latest` — didn't exist in this repo
   at all.** The CronJob pointed at an image with nothing behind it.
   **Fixed**: added `ops/Dockerfile`, pinned to `postgresql-client-16` to
   match the deployed server's major version (see finding 3), bundling both
   backup/restore scripts. Builds clean; verified `psql --version` inside
   it reports `16.14`.
3. **Client/server Postgres major-version mismatch silently breaks
   restores.** A locally installed `pg_dump` (v18, common on a dev laptop
   ahead of the pinned server version) emits a `SET transaction_timeout =
   ...` directive that Postgres 16 doesn't recognize
   (`transaction_timeout` is Postgres 17+ only) — `psql --set
   ON_ERROR_STOP=on` correctly aborts on it, but a real restore attempt
   with mismatched tooling would fail. **Fixed** by finding 2 (the ops
   image pins matching client tools) and by documenting the risk directly
   in `server/scripts/db-restore.js`.
4. **`server/scripts/db-restore.js` crashed with a raw, unhandled `EPIPE`
   stack trace instead of surfacing the real error.** When `psql` exits
   early (e.g. because of finding 3), its stdin closes while the gunzip
   stream is still writing to it — an expected `EPIPE` that had no error
   handler, so it crashed the whole Node process instead of reporting
   `psql`'s actual stderr (`unrecognized configuration parameter
   "transaction_timeout"`). **Fixed**: `EPIPE` on `psql.stdin` is now
   swallowed (psql's own exit code + stderr already carry the real reason);
   genuine stream errors (e.g. a corrupt archive) still surface cleanly.

## Measured numbers

Two scales, both via the real `ops/Dockerfile` image and real
`pg-backup.sh`/`pg-restore.sh`, both with **zero data loss** (exact
row-count match across every table):

| Scale | DB size | Compressed backup | Backup wall-clock | Restore wall-clock |
|---|---|---|---|---|
| Demo dataset (`seed-riverside-demo.js`, 17 non-empty tables) | ~1 MB | 18.6 KB | 682 ms – 3.5 s* | ~5.8 s (incl. container cold-start) |
| Demo + 50,000 synthetic rows | 26 MB | 722.9 KB | 3.5 s | ~5.2 s (incl. container cold-start) |

\* The smaller run's backup timing is from `server/scripts/db-backup.js`'s
self-reported `durationMs` (682 ms, excludes container startup); the
larger run's timing is wall-clock around the full `docker run`
invocation (includes container cold-start), which is why it isn't a clean
apples-to-apples comparison — both are reported rather than picking the
more flattering one.

**What this does and doesn't prove.** This confirms the mechanism itself
is now correct and genuinely idempotent at demo/small-production scale, and
it caught 3 bugs that would have caused a real incident to turn into a
failed recovery. It does **not** certify a specific RTO number at real
production data scale (GBs, not tens of MB) — `pg_dump`/`psql` scale
roughly linearly with data volume, so re-run this same drill (steps below)
once real customer data volume exists, or before relying on a specific RTO
figure in an SLA.

## RPO / RTO, stated honestly per deployment path

This repo has two backup paths with materially different RPO, and neither
number below is a guess — each is derived from a real, committed
configuration value:

- **GCP Cloud SQL (the primary target — `deploy/terraform-gcp/main.tf`)**:
  `backup_configuration { enabled = true, point_in_time_recovery_enabled =
  true (prod), transaction_log_retention_days = 7 }`. Google's own PITR
  mechanism gives near-continuous recovery within that 7-day window (not
  "restore from last nightly dump") — this is the real, intended
  production RPO once a live GCP project exists to deploy into (see
  TODO.md: no live GCP billing account is currently available, so this
  path is configured and reviewed but not independently exercised the way
  the drill above was).
- **Helm/Kubernetes CronJob path
  (`deploy/helm/templates/backup-cronjob.yaml`)**: `schedule: "17 2 * * *"`
  — one backup per day. **RPO ≈ 24 hours worst-case** (a disaster
  immediately before the next scheduled run loses up to a full day of
  writes). This is the path this drill actually exercised end-to-end.
- **RTO**: measured above for the mechanism itself (~5–6 seconds at
  demo/26 MB scale, including container cold-start). Real production RTO
  additionally includes whatever it takes to provision a target database
  to restore into (a new Cloud SQL instance, or `pg-restore.sh`'s existing
  restore-in-place path if the instance survives) — not measured here
  since no live instance exists to time that against.

## Re-running this drill

```bash
docker run -d --name scopecash-dr-drill -e POSTGRES_USER=scopecash-ai \
  -e POSTGRES_PASSWORD=<pick one> -e POSTGRES_DB=scopecash-ai -p 5544:5432 postgres:16
# wait for healthy, then from server/:
DATABASE_URL=postgresql://scopecash-ai:<pw>@localhost:5544/scopecash-ai \
  npx prisma migrate deploy --config prisma.postgres.config.ts
DATABASE_URL=postgresql://scopecash-ai:<pw>@localhost:5544/scopecash-ai \
  node prisma/seed-riverside-demo.js

docker build -t scopecash-ai-ops:local -f ops/Dockerfile ops/

docker run --rm -e DATABASE_URL=postgresql://scopecash-ai:<pw>@host.docker.internal:5544/scopecash-ai \
  -e BACKUP_DESTINATION=file:///backups -v <local-dir>:/backups \
  --entrypoint /usr/local/bin/pg-backup.sh scopecash-ai-ops:local

# simulate disaster
psql ... -c 'DROP DATABASE "scopecash-ai"; CREATE DATABASE "scopecash-ai";'

docker run --rm -v <local-dir>:/backups:ro \
  --entrypoint /usr/local/bin/pg-restore.sh scopecash-ai-ops:local \
  file:///backups/<archive>.sql.gz postgresql://scopecash-ai:<pw>@host.docker.internal:5544/scopecash-ai

# verify: compare per-table row counts before and after
docker rm -f scopecash-dr-drill
```
