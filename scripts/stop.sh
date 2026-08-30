#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$PROJECT_ROOT/.runtime/frontend.pid"

if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    COMMAND_NAME="$(ps -p "$PID" -o comm= 2>/dev/null || true)"
    if [[ "$COMMAND_NAME" == *node* ]]; then
      kill "$PID"
      printf 'Management frontend stopped.\n'
    fi
  fi
  rm -f -- "$PID_FILE"
fi

cd "$PROJECT_ROOT"
docker compose down
printf 'FreeSWITCH and backend API stopped. Persistent volumes were preserved.\n'
