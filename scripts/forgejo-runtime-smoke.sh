#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

install_docker_client() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Forgejo runtime smoke requires a Debian-based job image." >&2
    return 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "debian" ]]; then
    echo "Unsupported Forgejo job image OS: ${ID:-unknown}. Expected Debian." >&2
    return 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  local arch codename
  arch="$(dpkg --print-architecture)"
  codename="${VERSION_CODENAME:-bookworm}"
  printf '%s\n' "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin
}

wait_for_liveness() {
  local control_url="$1"
  local data_url="$2"

  for attempt in $(seq 1 60); do
    if curl -fsS "${control_url}/healthz" >/dev/null && curl -fsS "${data_url}/healthz" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for control/data plane liveness." >&2
  return 1
}

install_docker_client

# Forgejo Runner launches this job through the remote DinD daemon. Inside the
# nested job container, its default gateway is the DinD host namespace. The
# daemon listens there on 2375; service containers using network_mode: host
# are reachable through the same gateway rather than this job's localhost.
dind_gateway="${RHEINAGENT_FORGEJO_DIND_GATEWAY:-$(ip route | awk '/default/ {print $3; exit}')}"
if [[ -z "$dind_gateway" ]]; then
  echo "Could not resolve the Forgejo DinD gateway." >&2
  exit 1
fi

export DOCKER_HOST="tcp://${dind_gateway}:2375"
control_url="http://${dind_gateway}:3901"
data_url="http://${dind_gateway}:3902"
export RHEINAGENT_FILE_UPLOAD_SMOKE_CONTROL_URL="$control_url"
export RHEINAGENT_FILE_UPLOAD_SMOKE_DATA_URL="$data_url"

run_token="${FORGEJO_RUN_ID:-${GITHUB_RUN_ID:-$$}}"
run_token="$(printf '%s' "$run_token" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
export COMPOSE_PROJECT_NAME="ra-file-upload-${run_token}"

compose=(docker compose -f docker-compose.yml -f .forgejo/docker-compose.ci.yml)
state_file=".runtime-smoke-state.json"

cleanup() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    echo "Forgejo runtime smoke failed; collecting container state." >&2
    "${compose[@]}" ps || true
    "${compose[@]}" logs --no-color || true
  fi
  "${compose[@]}" down -v --remove-orphans || true
  rm -f "$state_file"
  exit "$rc"
}
trap cleanup EXIT

echo "Using Forgejo DinD gateway ${dind_gateway}."
docker --version
docker compose version
docker version

"${compose[@]}" up -d --build
wait_for_liveness "$control_url" "$data_url"
"${compose[@]}" ps

npm run smoke:seed

"${compose[@]}" restart file-control file-data
wait_for_liveness "$control_url" "$data_url"

npm run smoke:verify

echo "Forgejo remote-DinD runtime smoke passed."
