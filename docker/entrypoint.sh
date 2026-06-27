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
  "$OPENCLAW" plugins install clawhub:@openclaw/whatsapp --pin --force \
    || echo "[entrypoint] WARN whatsapp plugin install failed"
fi

echo "[entrypoint] patching sticker support..."
npm run openclaw:patch-whatsapp-stickers || echo "[entrypoint] WARN sticker patch failed"

echo "[entrypoint] installing local dispatch plugin..."
"$OPENCLAW" plugins install ./openclaw-plugins/whatsapp-policy-dispatch --force \
  || echo "[entrypoint] WARN dispatch plugin install failed"

echo "[entrypoint] repairing OpenClaw config..."
npm run openclaw:repair-config || echo "[entrypoint] WARN config repair failed"

echo "[entrypoint] starting gateway + control + worker via supervisord"
exec supervisord -c /app/docker/supervisord.conf
