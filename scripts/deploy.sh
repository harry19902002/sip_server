#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.runtime"
ENV_FILE="$PROJECT_ROOT/.env"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"
VALIDATE_ONLY="${VALIDATE_ONLY:-false}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

env_value() {
  awk -F= -v key="$1" '$0 ~ "^[[:space:]]*" key "[[:space:]]*=" { sub(/^[^=]*=/, ""); gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, ""); value=$0 } END { print value }' "$ENV_FILE"
}

wait_http() {
  local name="$1" url="$2" timeout="$3" elapsed=0
  until curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; do
    (( elapsed >= timeout )) && fail "$name did not become ready within ${timeout}s: $url"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  printf '%s is ready: %s\n' "$name" "$url"
}

stop_managed_frontend() {
  local pid_file="$RUNTIME_DIR/frontend.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    local command_name
    command_name="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
    if [[ "$command_name" == *node* ]]; then
      step "Stopping the previously managed frontend"
      kill "$pid"
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
    fi
  fi
  rm -f -- "$pid_file"
}

cd "$PROJECT_ROOT"
step "Validating prerequisites"
for command_name in node npm docker curl awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && (b<13 || (b===13 && c<0)))) process.exit(1)' || fail "Node.js 22.13.0 or newer is required."

if [[ ! -f "$ENV_FILE" ]]; then
  cp -- "$PROJECT_ROOT/.env.example" "$ENV_FILE"
  fail "Created .env from .env.example. Replace all replace-with-* values, then run this script again."
fi

for name in ESL_PASSWORD FREESWITCH_API_KEY SIP_DEFAULT_PASSWORD; do
  value="$(env_value "$name")"
  [[ -n "$value" && ! "$value" =~ replace-with|change-me|example ]] || fail "Set a non-placeholder value for $name in .env."
done

docker info >/dev/null 2>&1 || fail "Docker Engine is unavailable. Start Docker and retry."
docker compose config --quiet

if [[ "$VALIDATE_ONLY" == "true" ]]; then
  printf 'Deployment configuration is valid.\n'
  exit 0
fi

if [[ "$SKIP_INSTALL" != "true" ]]; then
  step "Installing locked Node.js dependencies"
  npm ci
fi

step "Building and starting FreeSWITCH and the backend API"
if [[ "$SKIP_BUILD" == "true" ]]; then
  docker compose up -d
else
  docker compose up -d --build
fi

API_PORT="$(env_value FREESWITCH_API_PORT)"
API_PORT="${API_PORT:-3001}"
API_HEALTH_URL="http://127.0.0.1:${API_PORT}/health"
wait_http "Backend API" "$API_HEALTH_URL" "$TIMEOUT_SECONDS"

step "Building the management frontend"
npm run build

mkdir -p -- "$RUNTIME_DIR"
stop_managed_frontend
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$FRONTEND_PORT" | grep -q LISTEN; then
  fail "Port $FRONTEND_PORT is occupied. Stop that process or set FRONTEND_PORT to another port."
fi

step "Starting the management frontend"
nohup node node_modules/vinext/dist/cli.js start --hostname 0.0.0.0 --port "$FRONTEND_PORT" \
  >"$RUNTIME_DIR/frontend.out.log" 2>"$RUNTIME_DIR/frontend.err.log" &
FRONTEND_PID=$!
printf '%s' "$FRONTEND_PID" > "$RUNTIME_DIR/frontend.pid"
wait_http "Management frontend" "http://127.0.0.1:${FRONTEND_PORT}/" 60

step "Deployment completed"
docker compose ps
printf 'Management UI : http://127.0.0.1:%s/\n' "$FRONTEND_PORT"
printf 'Backend health: %s\n' "$API_HEALTH_URL"
printf 'Stop services : npm run deploy:stop:linux\n'
