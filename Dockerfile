# Portable image for the OpenClaw WhatsApp bot.
#
# All AI runs on Cloudflare Workers AI + Tavily over HTTP (chat, vision, image
# generation, transcription, web search) — no local model/CLI. Only voice replies
# need local Python edge-tts + ffmpeg. This makes the bot shippable anywhere a
# container runs, including Oracle Cloud Always Free (ARM Ampere A1).
#
# Build (on the target host, e.g. the Oracle ARM VM, for a native arch):
#   docker build -t whatsapp-bot .
# Run (see docs/operations/docker.md for the full env + volume guide). BOTH
# mounts matter: /data holds the policy; the OpenClaw linked-device session +
# plugins live in /root/.openclaw, so without that mount every `docker run`
# re-prompts the QR. scripts/deploy/bot.sh always uses both.
#   docker run -d --name whatsapp-bot --env-file .env \
#     -v wa-data:/data -v wa-data/openclaw:/root/.openclaw whatsapp-bot
FROM node:22-bookworm-slim

# System deps:
# - ffmpeg: convert edge-tts mp3 -> opus/ogg WhatsApp voice notes
# - python3 + pip: run scripts/local-tts.py (edge-tts) and the sticker prep (Pillow)
# - git/curl/ca-certificates: OpenClaw plugin install from clawhub
# - supervisor: keep gateway/control/worker running
# - tini: PID 1 init for clean signals + zombie reaping
# - tzdata: so TZ=America/Sao_Paulo resolves (weather date math, logs, quiet hours)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip git curl ca-certificates supervisor tini tzdata \
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
# TZ: the host runs UTC; weather "hoje/amanhã/sexta" and a specific date are
# computed in the runtime zone, so without this they're off by one near local
# midnight. Override TZ for a different audience.
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    OPENCLAW_COMMAND=node_modules/.bin/openclaw \
    SPEECH_PROVIDER=local \
    SPEECH_LOCAL_TTS_PYTHON=python3 \
    MEDIA_STICKER_PYTHON=python3 \
    MEDIA_FFMPEG_COMMAND=ffmpeg \
    BOT_POLICY_PATH=/data/bot-policy.local.json

# /data holds the policy and generated media. NOTE: the OpenClaw linked-device
# session + installed plugins live in /root/.openclaw, which must be mounted
# separately (see the run example above) or the QR is re-prompted every recreate.
VOLUME ["/data"]

# No inbound ports are required: the worker hook (8790) is internal to the
# container; the bot only makes outbound HTTPS to Cloudflare/Tavily/WhatsApp.
# HEALTHCHECK probes the worker's /healthz so a crash-looped/FATAL worker shows
# as unhealthy in `docker ps` instead of the container looking up while dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8790/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
