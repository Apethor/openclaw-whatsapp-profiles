#!/usr/bin/env bash
# Container entrypoint: do the one-time OpenClaw setup (idempotent), then hand off
# to supervisord which keeps the gateway, control and worker running. Mirrors the
# setup steps in scripts/warmup-linux.ts but leaves the long-lived processes to
# supervisord so the container stays in the foreground.
set -euo pipefail
cd /app

OPENCLAW="${OPENCLAW_COMMAND:-node_modules/.bin/openclaw}"

echo "[entrypoint] ensuring OpenClaw WhatsApp plugin..."
if "$OPENCLAW" plugins inspect whatsapp 2>/dev/null | grep -q "Status: loaded"; then
  echo "[entrypoint] whatsapp plugin already installed"
else
  # Load-bearing: without it the bot can't receive WhatsApp messages at all, so
  # a soft-fail here would start a dead container. Fail hard and let the restart
  # policy retry instead of masking the outage.
  "$OPENCLAW" plugins install clawhub:@openclaw/whatsapp --pin --force || {
    echo "[entrypoint] FATAL whatsapp plugin install failed" >&2
    exit 1
  }
fi

echo "[entrypoint] patching sticker support..."
npm run openclaw:patch-whatsapp-stickers || echo "[entrypoint] WARN sticker patch failed (stickers only)"

echo "[entrypoint] installing local dispatch plugin..."
# Also load-bearing: dispatch routes inbound messages to the worker.
"$OPENCLAW" plugins install ./openclaw-plugins/whatsapp-policy-dispatch --force || {
  echo "[entrypoint] FATAL dispatch plugin install failed" >&2
  exit 1
}

echo "[entrypoint] repairing OpenClaw config..."
npm run openclaw:repair-config || echo "[entrypoint] WARN config repair failed"

echo "[entrypoint] starting gateway + control + worker via supervisord"
exec supervisord -c /app/docker/supervisord.conf
