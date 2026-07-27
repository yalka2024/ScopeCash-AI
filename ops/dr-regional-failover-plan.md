# Regional failover — DR plan

Written 2026-07-27. This is a plan, not a drilled procedure — the ONE
piece of it that IS drillable today (graceful instance shutdown/drain) was
drilled for real; the rest genuinely cannot be, for reasons explained
below, and this document says so plainly rather than implying otherwise.
See TODO.md "DR/regional failover exercises" and STATUS.md for the phase
this was written under.

## What "regional failover" would mean here, and why it can't be exercised yet

A real regional failover drill means: the primary GCP region becomes
unavailable, and the platform keeps serving traffic (or comes back up
within a stated RTO) from a second region. Doing that for real, even as a
paper exercise against real infrastructure, needs infrastructure this
deployment does not have:

- **No live GCP project exists at all.** Confirmed repeatedly this
  project cycle (see TODO.md's "Not achievable by an engineering agent"
  section) — `deploy/terraform-gcp/main.tf` has never been applied. There
  is nothing running to fail over, in one region or several.
- **The Terraform module is architecturally single-region, not just
  unapplied.** One Cloud SQL instance (`availability_type = "REGIONAL"` —
  that's Google's term for *intra-region* zonal HA, not cross-region),
  one GCS bucket (`location = upper(var.region)`, a single-region
  bucket), one Cloud Run service, one VPC. There is no second-region
  variable anywhere to even point a failover plan at.
- **Secret Manager is *deliberately* pinned to one region, not by
  oversight.** `main.tf`'s `user_managed { replicas { location =
  var.region } }` has a comment explicitly rejecting Google's own
  `automatic { }` multi-region replication option, for data-residency
  reasons. This is a real, prior policy decision this plan does not
  reverse unilaterally — see "Open policy question" below.
- **The backup mechanism is periodic full-dump, not streaming
  replication.** `scripts/db-backup.js` / `ops/backup/pg-backup.sh` do
  `pg_dump`/`VACUUM INTO`, not a warm standby. There is no "promote a
  replica in region B" button to press because no replica exists, or
  could be drilled locally in any way that would tell you something true
  about a real cross-region promotion (network latency, replication lag,
  and DNS propagation are all inherently non-local).

None of this is a gap introduced by skipping work — it's the honest state
of a pre-launch, single-region deployment that has never been applied to
real infrastructure. Claiming a "regional failover exercise" happened
against that would be exactly the kind of status-document overclaim this
project's own operating rules exist to prevent.

## What WAS actually drilled, for real, today

`scripts/dr-drain-drill.js` (`npm run dr:drain-drill`) — a real,
passing, repeatable drill of graceful instance shutdown: builds the
real, unmodified `server/Dockerfile` image, runs it against a real
throwaway Postgres container, fires a real in-flight request, sends a
**real SIGTERM** via `docker kill` (not a simulated signal — Docker
forwards a genuine POSIX signal into the Linux container, exercising the
production image's actual `tini` PID-1 entrypoint), and asserts on the
real observed behavior. All 6 assertions pass:

1. The request already in flight when SIGTERM arrived completes
   successfully (not aborted).
2. A new request sent after the signal is rejected with `503
   {code:'draining'}`.
3. `/api/health/live` still returns 200 during drain (so an orchestrator
   can keep observing state — health paths are explicitly excluded from
   the drain guard for this reason).
4. `/api/health/ready` returns `503 {status:'draining'}` during drain.
5. The container actually exits, cleanly (exit code 0), within the
   configured shutdown timeout — not hung, not force-killed.

Why this matters for regional failover even though it isn't one: every
real resiliency scenario — a rolling deploy, an autoscaler removing an
instance, a zone eviction within a region, and eventually a real regional
failover — depends on this exact mechanism at the single-instance level.
If an instance can't shut down without dropping in-flight work or
accepting doomed new requests, nothing built on top of "traffic moves
between instances/zones/regions" can be trusted either. This was
previously completely undrilled — `lib/lifecycle.js` had zero test
coverage before this pass (see `tests/unit/lifecycle.test.js`, also new)
— so this closes a real, previously-silent gap, not a hypothetical one.

An earlier attempt at this drill tried a plain spawned child process
(`child.kill('SIGTERM')`) instead of Docker. That doesn't work on
Windows: confirmed by a minimal direct repro that Node's
`child_process.kill('SIGTERM')` on Windows performs an abrupt
`TerminateProcess` — the child's own `process.on('SIGTERM', ...)` handler
never runs at all. Production runs on Linux, where this is the standard,
correct pattern; Docker was used specifically to get a genuine Linux
signal path on a Windows development machine, not merely for
convenience.

## What real regional failover would require (written, not built)

If/when a live GCP project exists and this becomes a live priority, in
rough dependency order:

1. **Resolve the data-residency policy question first** (see below) —
   it determines whether steps 2-4 are even permitted as designed.
2. **Cross-region Cloud SQL read replica** (`google_sql_database_instance`
   with `replica_configuration`, in a second region) + a documented
   promotion runbook (`gcloud sql instances promote-replica`) with a
   real, measured promotion-time drill — analogous to
   `ops/backup/DR-DRILL-RESULTS.md`'s backup/restore drill, but for
   replica promotion instead of dump/restore.
3. **Cross-region object storage** for uploads — either a Turbo
   Replication / dual-region GCS bucket, or a periodic cross-region
   `gsutil rsync` job, chosen based on the RPO the business actually
   needs for uploaded evidence (photos/documents), not assumed.
4. **Secret Manager**: either accept the current single-region secret
   store becomes a hard dependency of the failover region too (secrets
   fetched cross-region at boot — adds latency and a cross-region
   dependency, but preserves the current residency stance), or revisit
   `automatic` replication (reverses the deliberate decision in
   `main.tf` — see below).
5. **DNS / traffic routing**: a global external HTTPS load balancer or
   Cloud DNS failover routing policy pointed at both regions' Cloud Run
   services, with health checks against `/api/health/ready` (already
   correctly wired to reflect real backend health, including drain
   state, per the drill above).
6. **Stateless pieces already fine as-is**: Cloud Tasks queues and Redis
   are inherently regional caches/queues, not sources of truth — losing
   them in a regional failure is a performance/retry event, not a data-
   loss event, so they don't block a failover the way the database does.
7. **Re-run the drain drill (this one) against the real target
   infrastructure** once it exists, plus a genuine cross-region
   promotion-and-cutover drill, before ever citing a specific RTO/RPO
   number for regional failover in a customer-facing SLA.

## Open policy question this plan deliberately does not decide

Cross-region replication (steps 2-4 above) is in real tension with the
data-residency stance `main.tf` already encodes on purpose — home-services
contractor evidence (photos, voice notes, contract documents, potentially
containing customer PII) replicated into a second geographic region is a
data-residency and compliance decision, not just an infrastructure one.
This plan intentionally does not make that call — an engineering pass
isn't the right place to unilaterally reverse an existing, deliberate
compliance-motivated architecture decision. Options, for whoever does make
this call:

- **Accept single-region risk, documented.** No cross-region replication;
  RTO/RPO for a genuine regional outage is "however long it takes to
  restand infrastructure from Cloud SQL PITR backups in a new region" —
  effectively a cold-start, not a failover. Cheapest, matches the current
  architecture, but does mean a real regional outage is a multi-hour (at
  best) outage, not a failover.
- **Same-jurisdiction multi-region** (e.g. two US regions, if the
  business's actual residency commitments allow it) — closes most of the
  RTO/RPO gap without crossing any jurisdiction boundary the current
  trust-portal/compliance claims (`DATA_RESIDENCY_REGION`,
  `trust-portal`/GDPR docs referenced elsewhere in this repo) depend on.
- **Full cross-region/cross-jurisdiction replication** — best RTO/RPO,
  but requires an explicit legal/compliance review and probably a
  trust-portal/DPA update before it's accurate to claim, not just an
  infrastructure change.

## RTO/RPO, stated honestly, today

- **Regional failover**: not a supported capability. No number is
  claimed. Treat a real regional outage today as: restore from Cloud SQL
  PITR backups (once a live project exists — see
  `ops/backup/DR-DRILL-RESULTS.md` for the real, measured backup/restore
  mechanism and its own honestly-stated RPO: ~24h worst-case via the
  Kubernetes CronJob path, near-continuous via Cloud SQL PITR once a live
  project exists) into fresh infrastructure in a surviving region — a
  cold rebuild, not a failover, and slower than either.
- **Single-instance / zone-level resiliency** (what this phase actually
  drilled): an individual instance now provably drains correctly under
  SIGTERM within its configured `SHUTDOWN_TIMEOUT_MS` (25s default in
  production, `index.js`), losing zero in-flight requests. This is table
  stakes for rolling deploys and autoscaling within a region, and was
  previously unverified.

## Re-running this drill

```bash
cd server
npm run dr:drain-drill
```

Needs Docker. Builds a real image from `server/Dockerfile`, runs it
against a throwaway Postgres container on a dedicated Docker network,
tears everything down on exit (success or failure) unless
`DRILL_KEEP_ON_FAIL=1` is set, in which case containers are left running
for inspection (`docker logs scopecash-dr-drill-server`) after a failure.
