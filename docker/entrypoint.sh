#!/usr/bin/env bash
# Container entrypoint: do the one-time OpenClaw setup (idempotent), then hand off
# to supervisord which keeps the gateway, control and worker running. Mirrors the
# setup steps in scripts/warmup-linux.ts but leaves the long-lived processes to
# supervisord so the container stays in the foreground.
set -euo pipefail
cd /app

OPENCLAW="${OPENCLAW_COMMAND:-node_modules/.bin/openclaw}"

# Load-bearing installs are fatal (a dead bot must not present as up), but retry
# a few times first so a transient clawhub blip rides out without bouncing the
# whole container through the restart policy.
install_with_retry() {
  desc="$1"; shift
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if "$@"; then
      return 0
    fi
    echo "[entrypoint] WARN $desc failed (attempt $attempt/3); retrying in 5s..." >&2
    attempt=$((attempt + 1))
    sleep 5
  done
  echo "[entrypoint] FATAL $desc failed after 3 attempts" >&2
  exit 1
}

echo "[entrypoint] ensuring OpenClaw WhatsApp plugin..."
if "$OPENCLAW" plugins inspect whatsapp 2>/dev/null | grep -q "Status: loaded"; then
  echo "[entrypoint] whatsapp plugin already installed"
else
  # Without it the bot can't receive WhatsApp messages at all.
  install_with_retry "whatsapp plugin install" "$OPENCLAW" plugins install clawhub:@openclaw/whatsapp --pin --force
fi

echo "[entrypoint] patching sticker support..."
npm run openclaw:patch-whatsapp-stickers || echo "[entrypoint] WARN sticker patch failed (stickers only)"

echo "[entrypoint] installing local dispatch plugin..."
# Also load-bearing: dispatch routes inbound messages to the worker (local path,
# so this should only fail on a genuinely broken checkout).
install_with_retry "dispatch plugin install" "$OPENCLAW" plugins install ./openclaw-plugins/whatsapp-policy-dispatch --force

echo "[entrypoint] repairing OpenClaw config..."
npm run openclaw:repair-config || echo "[entrypoint] WARN config repair failed"

echo "[entrypoint] starting gateway + control + worker via supervisord"
exec supervisord -c /app/docker/supervisord.conf
