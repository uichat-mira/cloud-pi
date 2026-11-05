#!/usr/bin/env bash
# Runs ONLY on the Mira node from Cloud Pi's own guarded GitHub Actions workflow.
set -Eeuo pipefail
umask 077
APP=/opt/cloud-pi
cd "$APP"
for file in dist/mira-cloud-pi-linux-amd64.tar.gz dist/mira-cloud-pi-linux-amd64.tar.gz.sha256 dist/compose.yaml dist/version.txt secrets/agent.env; do
  test -s "$file" || { echo "missing required deployment file: $file" >&2; exit 1; }
done
test -d data || { echo "missing persistent state directory" >&2; exit 1; }
SHA="$(cat dist/version.txt)"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid release SHA" >&2; exit 1; }
export CLOUD_PI_IMAGE="mira-cloud-pi:$SHA"
export CLOUD_PI_DATA_DIR="$APP/data"
export CLOUD_PI_SECRETS_FILE="$APP/secrets/agent.env"

(cd dist && sha256sum -c mira-cloud-pi-linux-amd64.tar.gz.sha256 && gzip -t mira-cloud-pi-linux-amd64.tar.gz)
docker compose -f dist/compose.yaml config --quiet
# Load the verified image without rebuilding anything or touching unrelated services.
gzip -dc dist/mira-cloud-pi-linux-amd64.tar.gz | docker load
test "$(docker image inspect "$CLOUD_PI_IMAGE" --format '{{.Architecture}}')" = amd64
# Fail BEFORE stopping the previous bot if the new image cannot access its mounts.
docker compose -f dist/compose.yaml run --rm --no-deps --entrypoint /bin/sh cloud-pi \
  -c 'test -r /run/secrets/agent.env && test -w /var/lib/cloud-pi' >/dev/null

previous=""
if test -f .deployed-cloud-pi-sha; then
  previous="$(cat .deployed-cloud-pi-sha)"
  [[ "$previous" =~ ^[a-f0-9]{40}$ ]] || previous=""
fi
if test "$previous" = "$SHA"; then
  echo "[cloud-pi] image already deployed, verifying health"
fi

install -d -m 0700 backups
if test -d data && find data -type f -print -quit | grep -q .; then
  tar -czf "backups/cloud-pi-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" data
fi

# One WebSocket owner per IM platform; Compose does not delete external services.
docker compose -f dist/compose.yaml stop cloud-pi || true
docker compose -f dist/compose.yaml up -d --no-build --pull never

healthy() {
  curl -fsS --max-time 3 http://127.0.0.1:8787/v1/health >/dev/null 2>&1 || return 1
  local code
  code="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8793/v1/status 2>/dev/null || true)"
  test "$code" = 401 || return 1
  test "$(docker inspect mira-cloud-pi --format '{{.State.Running}}')" = true || return 1
  test "$(docker inspect mira-cloud-pi-owner-gateway --format '{{.State.Running}}')" = true
}
for _ in $(seq 1 24); do
  if healthy; then
    printf '%s\n' "$SHA" > .deployed-cloud-pi-sha
    echo "[cloud-pi] deployed=$SHA loopback-agent=ok owner-gateway=401 (live IM @ not yet tested)"
    docker compose -f dist/compose.yaml ps
    exit 0
  fi
  sleep 3
done
echo "[cloud-pi] health failed on newly deployed image" >&2
if [[ "$previous" =~ ^[a-f0-9]{40}$ ]] && docker image inspect "mira-cloud-pi:$previous" >/dev/null 2>&1; then
  echo "[cloud-pi] attempting rollback to previous loaded image" >&2
  export CLOUD_PI_IMAGE="mira-cloud-pi:$previous"
  docker compose -f dist/compose.yaml up -d --no-build --pull never || true
  echo "[cloud-pi] rollback attempted; independent validation required" >&2
else
  echo "[cloud-pi] no verified prior loaded image available for automatic rollback" >&2
fi
exit 1
