#!/usr/bin/env bash
# ScopeCash AI — Postgres restore (DR drill or actual recovery).
#
# Usage:
#   pg-restore.sh <backup-uri> <target-database-url>
# Example:
#   pg-restore.sh s3://my-bucket/scopecash-ai/scopecash-ai-20260101T000000Z.sql.gz \
#                 postgresql://app:pass@new-host:5432/scopecash-ai_restored
#
# Verifies sha256 sidecar (if present), decrypts gpg if .gpg, gunzips, and pipes
# to psql. The target database MUST exist and be empty.

set -Eeuo pipefail

SRC="${1:?backup uri required}"
TARGET="${2:?target DATABASE_URL required}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LOCAL="$TMP/$(basename "$SRC")"

case "$SRC" in
  s3://*) aws s3 cp "$SRC" "$LOCAL" --only-show-errors
          aws s3 cp "${SRC}.sha256" "${LOCAL}.sha256" --only-show-errors || true ;;
  file://*) cp "${SRC#file://}" "$LOCAL"
            [[ -f "${SRC#file://}.sha256" ]] && cp "${SRC#file://}.sha256" "${LOCAL}.sha256" ;;
  *) echo "unknown scheme: $SRC" >&2; exit 2 ;;
esac

if [[ -f "${LOCAL}.sha256" ]]; then
  echo "[restore] verifying checksum"
  ( cd "$TMP" && sha256sum -c "$(basename "$LOCAL").sha256" )
fi

if [[ "$LOCAL" == *.gpg ]]; then
  echo "[restore] decrypting"
  gpg --batch --yes --decrypt --output "${LOCAL%.gpg}" "$LOCAL"
  LOCAL="${LOCAL%.gpg}"
fi

echo "[restore] applying to $TARGET (DRY-RUN row count after restore)"
gunzip -c "$LOCAL" | psql "$TARGET"

echo "[restore] sample row counts:"
psql "$TARGET" -c "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"
echo "[restore] done"

