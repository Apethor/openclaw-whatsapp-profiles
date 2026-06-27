#!/usr/bin/env bash
# Operate the deployed WhatsApp bot on its container host (e.g. the Oracle Cloud
# VM). One reusable entrypoint for the ops that were previously done by hand:
# logs, planner-decision inspection, status, restart, redeploy, and config/model
# changes. Reads connection details from scripts/deploy/deploy.env.
#
# Usage:
#   scripts/deploy/bot.sh <command> [args]
#
# Commands:
#   logs [--since 15m] [--follow] [--grep PATTERN]   container logs
#   actions [--since 25m]                            parse planner decisions
#                                                    (actions/weather/web-search/replies)
#   status                                           container + WhatsApp channel status
#   restart                                          restart the container (keeps the volume/session)
#   update                                           git pull + rebuild image + restart (deploy latest)
#   set-env KEY=VALUE [KEY=VALUE ...]                set env in .env.docker + restart
#                                                    (e.g. set-env RESPONDER_CLOUDFLARE_MODEL=@cf/...)
#   exec <cmd...>                                    run a command inside the container
#   ssh [cmd...]                                     ssh to the host (interactive if no cmd)
#   qr                                               (re)link WhatsApp via channels login (live QR)
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${DEPLOY_ENV:-$DEPLOY_DIR/deploy.env}"
if [ ! -f "$CONF" ]; then
  echo "Missing $CONF" >&2
  echo "Copy scripts/deploy/deploy.env.example to scripts/deploy/deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

: "${OCI_VM_HOST:?set OCI_VM_HOST in deploy.env}"
: "${OCI_SSH_KEY:?set OCI_SSH_KEY in deploy.env}"
OCI_VM_USER="${OCI_VM_USER:-ubuntu}"
CONTAINER_NAME="${CONTAINER_NAME:-whatsapp-bot}"
REMOTE_DIR="${REMOTE_DIR:-openclaw-whatsapp-profiles}"
DATA_DIR="${DATA_DIR:-/home/$OCI_VM_USER/wa-data}"

# Recreate the container (defined once so mounts/flags never drift across the
# restart/update/set-env commands). Both volumes matter: /data for policy+media,
# /root/.openclaw for the WhatsApp session + plugins.
#   - `docker rm -f ... || true`: removal is best-effort. Without `|| true` it
#     fails under `set -e` when the container is absent (first stand-up / manual
#     rm) and `docker run` would never execute.
#   - after starting, wait past the entrypoint's (now-fatal) plugin setup and
#     assert the container is still Running with RestartCount 0, so an entrypoint
#     failure ~10s in is caught instead of reported as "started".
RECREATE="sudo docker rm -f '$CONTAINER_NAME' >/dev/null 2>&1 || true; \
sudo docker run -d --name '$CONTAINER_NAME' --restart unless-stopped --env-file .env.docker \
  -v '$DATA_DIR':/data -v '$DATA_DIR'/openclaw:/root/.openclaw '$CONTAINER_NAME' >/dev/null \
&& sleep 10 \
&& [ \"\$(sudo docker inspect -f '{{.State.Running}}' '$CONTAINER_NAME' 2>/dev/null)\" = true ] \
&& [ \"\$(sudo docker inspect -f '{{.RestartCount}}' '$CONTAINER_NAME' 2>/dev/null)\" = 0 ]"

SSH_OPTS=(-i "$OCI_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

remote() { ssh "${SSH_OPTS[@]}" "$OCI_VM_USER@$OCI_VM_HOST" "$@"; }

PY="$(command -v python3 || command -v python || echo python)"

cmd="${1:-}"; shift || true

case "$cmd" in
  logs)
    SINCE="15m"; FOLLOW=""; PATTERN=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --follow|-f) FOLLOW="-f"; shift ;;
        --grep) PATTERN="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -n "$FOLLOW" ]; then
      remote "sudo docker logs -f --since '$SINCE' '$CONTAINER_NAME'"
    elif [ -n "$PATTERN" ]; then
      remote "sudo docker logs --since '$SINCE' '$CONTAINER_NAME' 2>&1 | grep -iE '$PATTERN'"
    else
      remote "sudo docker logs --since '$SINCE' '$CONTAINER_NAME' 2>&1 | tail -120"
    fi
    ;;

  actions)
    SINCE="25m"
    [ "${1:-}" = "--since" ] && { SINCE="$2"; shift 2; }
    remote "sudo docker logs --since '$SINCE' '$CONTAINER_NAME' 2>&1 | grep -E '\"msg\":\"(openclaw inbound message normalized|agent action plan unavailable|action planner failed|web search failed|auto reply approved)\"' || true" \
      | "$PY" -c "
import sys, json
for line in sys.stdin:
    i = line.find('{')
    if i < 0: continue
    try: d = json.loads(line[i:].strip())
    except Exception: continue
    m = d.get('msg', '')
    if 'unavailable' in m or 'planner failed' in m:
        print('PLANNER FAIL:', d.get('plannerError') or d.get('parseError') or '?')
    elif 'web search failed' in m:
        print('WEB SEARCH FAIL:', d.get('reason') or '?', '| query:', d.get('query') or '?')
    elif m == 'auto reply approved':
        print('  REPLY:', repr((d.get('reply') or '')[:200]))
    else:
        print('NORMALIZED actions=%s weather=%s webSearch=%s webSearchFailed=%s model=%s'
              % (d.get('plannedActions'), d.get('weatherStatus'), d.get('webSearchResults'), d.get('webSearchFailed'), d.get('responderModel')))
"
    ;;

  status)
    echo "=== container ==="
    remote "sudo docker ps -a --filter name='$CONTAINER_NAME' --format '{{.Status}} (restarts: {{.RestartCount}})' 2>/dev/null; sudo docker inspect -f 'restarts={{.RestartCount}}' '$CONTAINER_NAME' 2>/dev/null || true"
    echo "=== health ==="
    remote "sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' '$CONTAINER_NAME' 2>/dev/null || true"
    echo "=== WhatsApp channel ==="
    remote "out=\$(timeout 30 sudo docker exec '$CONTAINER_NAME' node_modules/.bin/openclaw channels status 2>&1); rc=\$?; if [ \$rc -eq 124 ]; then echo '(channel status timed out)'; else echo \"\$out\" | grep -i whatsapp || echo '(no whatsapp channel line — disconnected or starting)'; fi"
    ;;

  restart)
    remote "set -e; cd ~/$REMOTE_DIR && $RECREATE && echo 'restarted (session persists in the volume; no re-scan needed)'"
    ;;

  update)
    echo "Pulling latest, rebuilding (slow on small VMs), then restarting..."
    remote "set -e; cd ~/$REMOTE_DIR && git pull && echo 'building...' && sudo docker build -t '$CONTAINER_NAME' . && $RECREATE && echo 'deployed latest + restarted'"
    ;;

  set-env)
    [ $# -ge 1 ] || { echo "usage: bot.sh set-env KEY=VALUE [KEY=VALUE ...]" >&2; exit 1; }
    SETS=""
    for kv in "$@"; do
      key="${kv%%=*}"; val="${kv#*=}"
      # upsert KEY=VALUE in .env.docker
      SETS="$SETS sed -i '/^${key}=/d' .env.docker; echo '${key}=${val}' >> .env.docker;"
      echo "set $key=$val"
    done
    remote "set -e; cd ~/$REMOTE_DIR && $SETS $RECREATE && echo 'applied + restarted'"
    ;;

  exec)
    [ $# -ge 1 ] || { echo "usage: bot.sh exec <cmd...>" >&2; exit 1; }
    remote "sudo docker exec '$CONTAINER_NAME' $*"
    ;;

  qr)
    echo "Linking WhatsApp (scan the live QR with your phone)..."
    ssh -t "${SSH_OPTS[@]}" "$OCI_VM_USER@$OCI_VM_HOST" "sudo docker exec -it '$CONTAINER_NAME' node_modules/.bin/openclaw channels login --channel whatsapp --account default"
    ;;

  ssh)
    if [ $# -ge 1 ]; then remote "$*"; else ssh -t "${SSH_OPTS[@]}" "$OCI_VM_USER@$OCI_VM_HOST"; fi
    ;;

  ""|-h|--help|help)
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  *)
    echo "unknown command: $cmd (try: bot.sh help)" >&2
    exit 1
    ;;
esac
