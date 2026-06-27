# Docker / Cloud Deployment

The bot is fully portable: all AI runs on Cloudflare Workers AI + Tavily over
HTTP, and only voice replies use local `edge-tts` + `ffmpeg` (both baked into the
image). That makes it shippable to any container host, including **Oracle Cloud
Always Free** (ARM Ampere A1 — a genuinely free 24/7 VM).

## What the image runs

One container runs three processes under `supervisord`:

- `gateway` — OpenClaw WhatsApp connection (linked device).
- `control` — local send endpoint.
- `worker` — the bot (inbound policy/profiles, calls Cloudflare/Tavily).

`docker/entrypoint.sh` does the one-time OpenClaw plugin setup, then hands off to
supervisord. Logs go to `docker logs`.

## The `/data` volume (important)

Mount a volume at `/data`. It holds:

- `/data/baileys-auth/` — the WhatsApp linked-device session. **Without a
  persistent volume you must re-scan the QR every time the container is
  recreated.**
- `/data/bot-policy.local.json` — your profiles/targets policy (gitignored, not
  baked into the image — you provide it).

The image sets `BOT_AUTH_DIR=/data/baileys-auth` and
`BOT_POLICY_PATH=/data/bot-policy.local.json`.

## Preparing `.env` for the container

Start from your working `.env`, but **drop the Windows-specific lines** — the
image already sets the Linux equivalents:

- Remove `BOT_POLICY_PATH`, `BOT_AUTH_DIR` (image points them at `/data`).
- Remove `MEDIA_FFMPEG_COMMAND` / `CODEX_PROXY_FFMPEG_COMMAND` Windows paths
  (image uses `ffmpeg` on PATH).
- Remove `SPEECH_LOCAL_TTS_PYTHON` Windows value (image uses `python3`).

Keep the backend config (this is the whole point):

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
TAVILY_API_KEY=...
RESPONDER_PROVIDER=cloudflare
RESPONDER_CLOUDFLARE_MODEL=@cf/openai/gpt-oss-120b
IMAGE_GENERATOR_PROVIDER=cloudflare
IMAGE_GENERATOR_CLOUDFLARE_MODEL=@cf/black-forest-labs/flux-1-schnell
TRANSCRIBER_PROVIDER=cloudflare
SPEECH_PROVIDER=local
CLAUDE_PROXY_ENABLED=false
CODEX_PROXY_ENABLED=false
WHISPER_LOCAL_ENABLED=false
BOT_MODE=auto
OPENCLAW_WHATSAPP_DM_POLICY=open
# Required: OpenClaw >=2026.6.10 refuses to bind the gateway without auth.
OPENCLAW_GATEWAY_TOKEN=<a strong random token, e.g. openssl rand -hex 24>
```

(Image understanding auto-selects Cloudflare when `RESPONDER_PROVIDER=cloudflare`.)

### Gotchas learned in deployment

- **`OPENCLAW_GATEWAY_TOKEN` is mandatory.** Without it the gateway logs
  `Refusing to bind gateway to auto without auth` and never connects.
- **OpenClaw must be >=2026.6.10** (pinned in package.json) — the clawhub
  `@openclaw/whatsapp` plugin requires that runtime; older pins fail to install
  the WhatsApp channel in a fresh container.
- **Oracle Always Free ARM (A1.Flex) is often "out of host capacity".** The
  AMD `VM.Standard.E2.1.Micro` (1 GB) is the reliable fallback; add ~3 GB swap
  (`fallocate`/`mkswap`/`swapon`) so `npm install` and the build don't OOM.
- The native sticker patch (`openclaw:patch-whatsapp-stickers`) does not apply
  on 2026.6.10 yet (non-fatal warning); native sticker sending may be unavailable.

## Build & run

Build on the target host so the architecture matches (Oracle = arm64):

```bash
docker build -t whatsapp-bot .

docker run -d --name whatsapp-bot \
  --restart unless-stopped \
  --env-file .env.docker \
  -v /home/ubuntu/wa-data:/data \
  -v /home/ubuntu/wa-data/openclaw:/root/.openclaw \
  whatsapp-bot
```

**Both mounts matter.** `/data` holds the policy and `BOT_AUTH_DIR`, but the
OpenClaw WhatsApp **linked-device session lives in `/root/.openclaw`** (along with
the installed plugins). Persist it too, or every `docker run` (recreating the
container) drops the link and re-prompts the QR — a `docker restart` of the same
container would keep it, but recreation (image update, model change) would not.
Persisting it also skips the per-start plugin reinstall.

`scripts/deploy/bot.sh` (see Operations below) always uses both mounts.

Put your `bot-policy.local.json` into the bind-mounted data dir before first start:

```bash
mkdir -p /home/ubuntu/wa-data
cp bot-policy.local.json /home/ubuntu/wa-data/bot-policy.local.json
```

## First run: link WhatsApp

On first start there is no session, so the gateway prints a QR (or pairing code)
in the logs. Scan it from your phone (WhatsApp → Linked devices):

```bash
docker logs -f whatsapp-bot
```

After linking, the session persists in the `wa-data` volume. Your phone must come
online at least once every ~14 days or WhatsApp unlinks the device. Only one host
may use a given session at a time — do not run it in two places.

## Oracle Cloud Always Free (outline)

1. Create an **Ampere A1 (arm64)** VM, Ubuntu 22.04, in an Always Free shape.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`.
3. Copy the repo (git clone), add `.env.docker` and `bot-policy.local.json`.
4. `docker build -t whatsapp-bot .` then the `docker run` above.
5. `docker logs -f whatsapp-bot` and scan the QR.
6. Open egress only as needed; the bot makes outbound HTTPS to Cloudflare/Tavily
   and WhatsApp — no inbound ports are required unless you use the Twilio webhook.

## Operations

`scripts/deploy/bot.sh` wraps the day-to-day ops from any machine (no need to SSH
by hand). Copy `scripts/deploy/deploy.env.example` to `scripts/deploy/deploy.env`
(gitignored) and set `OCI_VM_HOST` + `OCI_SSH_KEY`. Then:

```bash
bash scripts/deploy/bot.sh status            # container + WhatsApp channel state
bash scripts/deploy/bot.sh logs --since 20m  # logs (add --follow or --grep PATTERN)
bash scripts/deploy/bot.sh actions           # parse planner decisions + replies
bash scripts/deploy/bot.sh restart           # restart (keeps the session)
bash scripts/deploy/bot.sh update            # git pull + rebuild + restart (deploy latest)
bash scripts/deploy/bot.sh set-env RESPONDER_CLOUDFLARE_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct
bash scripts/deploy/bot.sh qr                # (re)link WhatsApp via a live QR
bash scripts/deploy/bot.sh exec <cmd>        # run a command inside the container
bash scripts/deploy/bot.sh ssh [cmd]         # ssh to the host
```

`set-env` is the quick way to change a single setting (e.g. the chat model)
without a rebuild — it upserts the key in `.env.docker` and restarts.

Raw equivalents if you are on the host:

```bash
docker logs -f whatsapp-bot
docker restart whatsapp-bot
docker exec -it whatsapp-bot bash
```
