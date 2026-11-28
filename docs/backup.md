# Backup & restore

Forge state lives in two places that must be snapshotted together:

1. **Postgres** — users, sessions, PRs, intents, releases, queue, embeddings, audit log.
2. **`FORGE_STORAGE_ROOT`** — bare git repos (the actual code) and the SSH host key.

`scripts/backup.sh` takes a Postgres advisory lock, then produces a
timestamped `db-*.sql.gz` + `repos-*.tar.gz` pair:

```bash
DATABASE_URL=postgresql://forge:forge@localhost:5432/forge \
FORGE_STORAGE_ROOT=/data ./scripts/backup.sh
```

Run it from cron (daily is a reasonable start). For large installs,
prefer volume-level snapshots of both halves taken while the app is
paused — the script is the portable baseline.

## Restore

1. Stop the app (`docker compose down`).
2. Extract the repos tarball into `$FORGE_STORAGE_ROOT`.
3. Pipe the SQL dump into a fresh database.
4. Boot — migrations run automatically and the boot repair pass
   reinstalls git hooks into every repo.

If the database is newer than the repos (restored from mismatched
halves), repo rows may reference missing bare dirs; delete those rows or
restore the matching pair. If the repos are newer, extra bare dirs are
invisible to the app until rows exist — harmless.
