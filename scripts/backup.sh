#!/usr/bin/env bash
# Consistent backup of Forge's two halves: the Postgres database and the
# bare git repos under FORGE_STORAGE_ROOT. Takes a Postgres advisory lock
# so pushes can't race the tar, then dumps both next to each other.
#
# Usage: FORGE_STORAGE_ROOT=/data DATABASE_URL=... ./scripts/backup.sh [outdir]
set -euo pipefail

STORAGE_ROOT="${FORGE_STORAGE_ROOT:?FORGE_STORAGE_ROOT must be set}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
OUTDIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUTDIR"

# NOTE on consistency: the push path does NOT take this advisory lock —
# pushes can land mid-tar. For a consistent pair, pause the app first
# (docker compose stop web) or use volume-level snapshots; this script
# is the portable baseline and pairs a slightly-skewed db+repos tuple.
psql "$DATABASE_URL" -c "SELECT pg_advisory_lock(918273645);" >/dev/null
trap 'psql "$DATABASE_URL" -c "SELECT pg_advisory_unlock(918273645);" >/dev/null' EXIT

echo "[backup] dumping database…"
pg_dump "$DATABASE_URL" | gzip > "$OUTDIR/db-$STAMP.sql.gz"

echo "[backup] archiving repos from $STORAGE_ROOT…"
tar -czf "$OUTDIR/repos-$STAMP.tar.gz" -C "$STORAGE_ROOT" repos

echo "[backup] done: $OUTDIR/db-$STAMP.sql.gz + repos-$STAMP.tar.gz"
cat <<NOTE
Restore order (on a fresh host):
  1. Stop the app:  docker compose down
  2. Restore repos: tar -xzf repos-$STAMP.tar.gz -C \$FORGE_STORAGE_ROOT
  3. Restore DB:    gunzip -c db-$STAMP.sql.gz | psql \$DATABASE_URL
  4. Boot:           docker compose up -d  (hook repair pass reinstalls
     git hooks; migrations run automatically)
NOTE
