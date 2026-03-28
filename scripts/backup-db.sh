#!/bin/bash
# Kinova Bot — PostgreSQL backup skripti
# Cron uchun: 0 3 * * * /home/ubuntu/qwerty/scripts/backup-db.sh

BACKUP_DIR="/home/ubuntu/backups"
DATE=$(date +%Y-%m-%d)
FILE="$BACKUP_DIR/kinovadb_$DATE.sql.gz"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

pg_dump -U kinovabot -h localhost kinovadb | gzip > "$FILE"

# Eski backuplarni o'chirish (7 kundan eski)
find "$BACKUP_DIR" -name "kinovadb_*.sql.gz" -mtime +$KEEP_DAYS -delete

echo "✅ Backup saqlandi: $FILE"
