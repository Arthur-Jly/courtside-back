#!/bin/sh
# MySQL backup with 14-day rotation. Run daily via cron:
#   0 3 * * * /app/scripts/backup-db.sh /backups
# Requires: mysqldump, gzip. Env: DB_HOST DB_USER DB_PASSWORD DB_NAME
set -eu

DEST="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DEST/courtside-$STAMP.sql.gz"

mkdir -p "$DEST"
mysqldump \
  --host="${DB_HOST:-127.0.0.1}" \
  --user="${DB_USER:-root}" \
  --password="$DB_PASSWORD" \
  --single-transaction --quick --routines \
  "${DB_NAME:-sport}" | gzip > "$FILE"

echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Rotation
find "$DEST" -name 'courtside-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

# Restore:
#   gunzip < courtside-YYYYMMDD-HHMMSS.sql.gz | mysql -h HOST -u USER -p sport
