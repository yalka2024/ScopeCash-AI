#!/usr/bin/env bash
# ScopeCash AI — encrypted Postgres backup to S3 (or local dir).
#
# Required env:
#   DATABASE_URL                 postgres://user:pass@host:5432/db
#   BACKUP_DESTINATION           s3://bucket/prefix  OR  file:///var/backups/scopecash-ai
# Optional:
#   BACKUP_GPG_RECIPIENT         email/key id; if set, output is encrypted with gpg
#   BACKUP_RETENTION_DAYS        default 30
#   AWS_*                        standard AWS credential env (only when destination is s3://)
#
# Schedule via cron / k8s CronJob. Exits non-zero on any failure.

set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DESTINATION:?BACKUP_DESTINATION is required (s3://... or file://...)}"

RETENTION="${BACKUP_RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="scopecash-ai-${TS}.sql.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="${TMP}/${NAME}"

echo "[backup] dumping $DATABASE_URL → $OUT"
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$OUT"

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  echo "[backup] encrypting with gpg recipient=$BACKUP_GPG_RECIPIENT"
  gpg --batch --yes --trust-model always \
      --recipient "$BACKUP_GPG_RECIPIENT" \
      --output "${OUT}.gpg" --encrypt "$OUT"
  rm -f "$OUT"
  OUT="${OUT}.gpg"
  NAME="${NAME}.gpg"
fi

SHA="$(sha256sum "$OUT" | awk '{print $1}')"
echo "[backup] sha256=$SHA size=$(stat -c%s "$OUT") bytes"

case "$BACKUP_DESTINATION" in
  s3://*)
    aws s3 cp "$OUT" "${BACKUP_DESTINATION%/}/${NAME}" --only-show-errors
    echo "$SHA  $NAME" | aws s3 cp - "${BACKUP_DESTINATION%/}/${NAME}.sha256" --only-show-errors
    if [[ "$RETENTION" -gt 0 ]]; then
      CUTOFF=$(date -u -d "${RETENTION} days ago" +%Y-%m-%d)
      aws s3 ls "${BACKUP_DESTINATION%/}/" \
        | awk -v c="$CUTOFF" '$1 < c {print $4}' \
        | while read -r f; do
            [[ -n "$f" ]] && aws s3 rm "${BACKUP_DESTINATION%/}/$f" --only-show-errors
          done
    fi
    ;;
  file://*)
    DEST="${BACKUP_DESTINATION#file://}"
    mkdir -p "$DEST"
    cp "$OUT" "$DEST/$NAME"
    echo "$SHA  $NAME" > "$DEST/${NAME}.sha256"
    if [[ "$RETENTION" -gt 0 ]]; then
      find "$DEST" -type f -name "scopecash-ai-*.sql.gz*" -mtime +"$RETENTION" -delete
    fi
    ;;
  *)
    echo "[backup] unknown destination scheme: $BACKUP_DESTINATION" >&2
    exit 2
    ;;
esac

echo "[backup] uploaded $NAME"

