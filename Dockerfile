# Portable image for the OpenClaw WhatsApp bot.
#
# All AI runs on Cloudflare Workers AI + Tavily over HTTP (chat, vision, image
# generation, transcription, web search) — no local model/CLI. Only voice replies
# need local Python edge-tts + ffmpeg. This makes the bot shippable anywhere a
# container runs, including Oracle Cloud Always Free (ARM Ampere A1).
#
# Build (on the target host, e.g. the Oracle ARM VM, for a native arch):
#   docker build -t whatsapp-bot .
# Run (see docs/operations/docker.md for the full env + volume guide):
#   docker run -d --name whatsapp-bot --env-file .env -v wa-data:/data whatsapp-bot
FROM node:22-bookworm-slim

# System deps:
# - ffmpeg: convert edge-tts mp3 -> opus/ogg WhatsApp voice notes
# - python3 + pip: run scripts/local-tts.py (edge-tts) and the sticker prep (Pillow)
# - git/curl/ca-certificates: OpenClaw plugin install from clawhub
# - supervisor: keep gateway/control/worker running
# - tini: PID 1 init for clean signals + zombie reaping
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip git curl ca-certificates supervisor tini \
  && pip3 install --no-cache-dir --break-system-packages edge-tts 'pillow>=10.0' \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install node deps first for layer caching. The app runs TypeScript via tsx and
# needs the OpenClaw CLI, both declared as devDependencies, so install everything.
COPY package.json ./
RUN npm install --no-audit --no-fund

# App source (node_modules, data and .env are excluded via .dockerignore).
COPY . .

# Ensure the entrypoint is executable even when checked out on Windows.
RUN chmod +x /app/docker/entrypoint.sh

# Linux/container defaults that differ from the Windows .env.
ENV NODE_ENV=production \
    OPENCLAW_COMMAND=node_modules/.bin/openclaw \
    SPEECH_PROVIDER=local \
    SPEECH_LOCAL_TTS_PYTHON=python3 \
    MEDIA_FFMPEG_COMMAND=ffmpeg \
    BOT_AUTH_DIR=/data/baileys-auth \
    BOT_POLICY_PATH=/data/bot-policy.local.json

# Persists the WhatsApp linked-device session (baileys-auth) and the policy file.
# Without this volume the bot must re-scan the QR on every container recreation.
VOLUME ["/data"]

# No inbound ports are required: the worker hook (8790) is internal to the
# container; the bot only makes outbound HTTPS to Cloudflare/Tavily/WhatsApp.

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
