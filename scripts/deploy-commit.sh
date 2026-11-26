#!/usr/bin/env bash
# Puts one commit of main on the machine this runs on: back up, move the checkout to the
# commit, rebuild, start, and wait until the new server is healthy and stays up. If it is
# not, the commit that was running is started again and this fails.
#
#   bash scripts/deploy-commit.sh              # by hand, in ~/muster: the newest main
#   bash scripts/deploy-commit.sh <commit>     # a commit of main
#
# A job of your own may run it, with MUSTER_DIR naming the deployment's checkout. See
# docs/runbook.md.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0

cd "${MUSTER_DIR:-$(dirname "$0")/..}"
compose=(docker compose -f deploy/compose.yaml --env-file deploy/.env)

# The sandbox service starts containers through the socket of the Docker it runs on. That
# is the one this script's own `docker` talks to: under a rootless Docker it is the user's
# (/run/user/<uid>/docker.sock), and /var/run/docker.sock is the system's, which a
# container of a rootless Docker cannot open (found 2026-11-23).
if [ -z "${SANDBOX_DOCKER_SOCK:-}" ]; then
  sock="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed -n 's|^unix://||p')"
  if [ -n "$sock" ] && [ -S "$sock" ]; then export SANDBOX_DOCKER_SOCK="$sock"; fi
fi
# Only a commit's own name, or the newest main, is taken.
asked="${1:-origin/main}"
[[ "$asked" =~ ^([0-9a-f]{7,40}|origin/main)$ ]] || { echo "not a commit: $asked" >&2; exit 2; }
[ -f deploy/.env ] || { echo "deploy/.env is missing: this is not a deployment's checkout" >&2; exit 2; }

# One deployment at a time, whether a person or the runner started it.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/muster-deploy.lock"
flock -w 1800 9 || { echo "another deployment is still running" >&2; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "the checkout has changes of its own; not touching it:" >&2
  git status --short --untracked-files=no >&2
  exit 2
fi

git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'
want="$(git rev-parse --verify --quiet "$asked^{commit}")" || { echo "no such commit: $asked" >&2; exit 2; }
# Only what is on main is ever deployed, and never something older than what runs.
git merge-base --is-ancestor "$want" origin/main || { echo "$want is not on main" >&2; exit 2; }
was="$(git rev-parse HEAD)"

# The commit the running server was built from, as its image says; empty when none runs.
running() {
  local id
  id="$("${compose[@]}" ps -q muster 2>/dev/null || true)"
  [ -n "$id" ] || return 0
  docker inspect -f '{{if .State.Running}}{{index .Config.Labels "org.opencontainers.image.revision"}}{{end}}' "$id" 2>/dev/null || true
}
# Builds and starts a commit, and says whether it is that commit, healthy, and still up
# twenty seconds later without having been restarted.
up() {
  local id
  MUSTER_COMMIT="$1" "${compose[@]}" up -d --build --wait --wait-timeout 300 || return 1
  id="$("${compose[@]}" ps -q muster)"
  [ "$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")" = "$1" ] || return 1
  sleep 20
  [ "$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' "$id")" = "healthy 0" ]
}

if [ "$(running)" = "$want" ]; then
  echo "already running $want"
  exit 0
fi
if [ "$was" != "$want" ] && git merge-base --is-ancestor "$want" "$was"; then
  echo "$want is older than what runs ($was); a newer deployment got here first"
  exit 0
fi

# A first deployment has no database yet and nothing to back up. After that the database
# is started if it was stopped, and no deployment goes ahead without a backup.
# Whether there is one is asked of its data, not of its container: a container that was
# taken away leaves the data behind. A Docker that does not answer stops the deployment
# here rather than passing for a first one. The project is named after the folder the
# compose file is in, unless COMPOSE_PROJECT_NAME says otherwise.
project="${COMPOSE_PROJECT_NAME:-deploy}"
has_db="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=db")"
if [ -n "$has_db" ]; then
  "${compose[@]}" up -d --wait db
  bash scripts/backup.sh
  # The newest 14 of each kind are kept.
  for kind in 'muster-2*.sql.gz' 'muster-files-*.tar.gz'; do
    # shellcheck disable=SC2012,SC2086
    ls -1t deploy/backups/$kind 2>/dev/null | tail -n +15 | xargs -r rm -f -- || true
  done
fi

echo "deploying $want (was $was)"
git checkout --quiet --detach "$want"
if up "$want"; then
  echo "running $want"
  # Only images nothing uses and nothing names: other software on this machine keeps its own.
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "$want did not come up, or did not stay up; the server's last lines:" >&2
"${compose[@]}" logs --tail 40 muster >&2 || true
echo "going back to $was" >&2
git checkout --quiet --detach "$was"
# The database is left as it is. If the commit that failed had already changed it in a
# way the old code cannot read, the old code will not start either: restore the backup
# just written (docs/runbook.md, "Roll back").
if up "$was"; then
  echo "running $was again" >&2
else
  echo "$was does not come up either: the deployment is down" >&2
fi
exit 1
