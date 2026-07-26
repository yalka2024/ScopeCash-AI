# ScopeCash AI — ops image for scheduled backup/restore jobs
# (deploy/helm/templates/backup-cronjob.yaml references this as
# ghcr.io/your-org/scopecash-ai-ops:latest — replace "your-org" with the
# real GHCR namespace when wiring up publishing).
#
# Client tools are pinned to postgresql-client-16 to match the deployed
# server's major version (docker-compose.yml's `postgres:16`,
# deploy/terraform-gcp/main.tf's `database_version = "POSTGRES_16"`) — a
# real DR drill (see ops/backup/DR-DRILL-RESULTS.md) found that a NEWER
# pg_dump (e.g. 18.x, common on a dev laptop) emits SET directives
# (`transaction_timeout`, Postgres 17+ only) that an older server's psql
# rejects outright, so a restore built with mismatched client tooling can
# fail even though the backup itself "succeeded." Bump this alongside any
# Postgres major-version upgrade, never independently of it.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates gnupg curl \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        postgresql-client-16 gzip gnupg awscli \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 ops \
    && useradd  --system --uid 1001 --gid ops --no-create-home --shell /usr/sbin/nologin ops

COPY backup/pg-backup.sh backup/pg-restore.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/pg-backup.sh /usr/local/bin/pg-restore.sh

USER ops
ENTRYPOINT ["/usr/local/bin/pg-backup.sh"]
