#!/usr/bin/env bash
# Writes the deployment's database and people's files to deploy/backups/. Run before every upgrade.
# A backup that could not be finished leaves no file behind, so every file here is a whole one.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p deploy/backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
compose=(docker compose -f deploy/compose.yaml --env-file deploy/.env)
part=""
trap '[ -n "$part" ] && rm -f "$part"' EXIT

out="deploy/backups/muster-$stamp.sql.gz"
part="$out.part"
# --clean --if-exists: the file first drops what it then recreates, so it can be played
# into a database that already has tables, which is what a restore is.
"${compose[@]}" exec -T db pg_dump --clean --if-exists -U muster muster | gzip > "$part"
gunzip -t "$part"
mv "$part" "$out"
echo "wrote $out"

files="deploy/backups/muster-files-$stamp.tar.gz"
part="$files.part"
# In a container of its own, so the files are backed up whether or not the server is up:
# a deployment that must repair a server that does not start still gets its backup.
"${compose[@]}" run --rm --no-deps -T --entrypoint tar muster -czf - -C /data files > "$part"
gunzip -t "$part"
mv "$part" "$files"
part=""
echo "wrote $files"
