# OpenClaw WhatsApp Profiles

Local-first policy and guidance layer for OpenClaw WhatsApp. It applies per-contact or per-group profiles and can generate drafts, controlled auto-replies, images, stickers, voice-note transcriptions, and audio replies.

The main flow is OpenClaw-only. Twilio support is included as an experimental webhook adapter for sandbox testing, not as the primary runtime.

## Capabilities

- Per-contact and per-group profiles with `observe`, `draft`, or gated `auto` replies.
- WhatsApp voice-note transcription with direct API transcription or local `whisper.cpp`.
- Inbound image understanding/OCR, profile-gated with `tools.imageUnderstanding=true`.
- Structured weather lookup through Open-Meteo using WhatsApp shared locations, coordinates, or city/bairro text.
- Image generation, profile-gated with `tools.imageGeneration=true`, delivered as WhatsApp media.
- Native WhatsApp sticker generation, profile-gated with `tools.stickerGeneration=true`, delivered through OpenClaw as `asSticker=true`.
- Audio replies, profile-gated with `voice.reply.enabled=true`, either on request or for every reply.
- Optional `codex-proxy` for local Codex CLI-backed responses, Codex image generation, local TTS, and local Whisper forwarding.

## What It Runs

- OpenClaw gateway: WhatsApp connection and delivery.
- `openclaw-control`: local send endpoint for manual/test sends.
- `openclaw-worker`: inbound policy/profile worker.
- Optional `codex-proxy`: local OpenAI-compatible wrapper for `codex exec` or local transcription forwarding.
- Optional `whisper-local`: local `whisper.cpp` transcription server for WhatsApp voice notes.
- Optional Twilio webhook worker for sandbox testing.

All managed process logs and pid files are written under `data/runtime/`.

The public default is a direct OpenAI-compatible API key through `RESPONDER_*`. `codex-proxy` is optional for users who want to back replies with a local Codex CLI session.

## Setup

Prerequisites:

- Node.js 20+ and npm.
- An OpenAI-compatible API key for the responder.
- OpenClaw CLI available on PATH, or `OPENCLAW_COMMAND` set in `.env`.
- Optional: Codex CLI installed and authenticated locally when using `CODEX_PROXY_ENABLED=true`.

Windows:

```bash
npm install
copy .env.example .env
copy config\bot-policy.example.json config\bot-policy.local.json
```

Edit `.env` and set:

```text
RESPONDER_API_KEY=your-api-key
RESPONDER_MODEL=gpt-4o-mini
```

Optional media setup:

```bash
npm run media:install
npm run tts:install
npm run warmup:whisper
```

Then opt profiles into the capabilities you want in `config/bot-policy.local.json`, for example `tools.imageUnderstanding=true`, `tools.imageGeneration=true`, `tools.stickerGeneration=true`, `voice.enabled=true`, or `voice.reply.enabled=true`. See [Guidance profiles](docs/operations/guidance-profiles.md) and [Codex proxy](docs/operations/codex-proxy.md) for the provider-specific environment variables.

Then start:

```bash
npm run warmup
npm run warmup:status
```

Linux, Orange Pi, or a small VPS:

```bash
npm install
cp .env.example .env
cp config/bot-policy.example.json config/bot-policy.local.json
```

Edit `.env` as above, then start:

```bash
npm run warmup:linux
npm run warmup:status
```

Pair WhatsApp in OpenClaw when prompted by the gateway. Keep `.env`, `data/`, and `config/bot-policy.local.json` private.

Use `npm install`, not `npm ci`. `package-lock.json` is intentionally not committed while this project is still changing quickly. Forks that run this long-term should commit their generated lockfile for reproducible installs.

## Daily Run

```bash
npm run warmup
npm run warmup:status
```

On Linux, use `npm run warmup:linux` instead of `npm run warmup`.

`warmup` and `warmup:linux` install/refresh the local OpenClaw dispatch plugin, repair the OpenClaw config for this project, and start:

- OpenClaw gateway on `127.0.0.1:18789`
- `openclaw-control` on `127.0.0.1:8788`
- `openclaw-worker` on `127.0.0.1:8790`
- optional `codex-proxy` on `127.0.0.1:8787` when `CODEX_PROXY_ENABLED=true`
- optional `whisper-local` on `127.0.0.1:2022` when `WHISPER_LOCAL_ENABLED=true`

To stop only processes started by the warmup manager:

```bash
npm run warmup:stop
```

On Windows, after setup, you can also double-click `start-chatbot.bat` to run warmup and status.

To start the same stack automatically when your Windows user logs in:

```bash
npm run service:install
npm run service:status
```

You can also double-click `install-chatbot-service.bat`. The scheduled task runs `start-chatbot.ps1 -NoPause -LogToFile`, so startup output is written to `data/runtime/start-chatbot.log`. To remove only the startup task:

```bash
npm run service:uninstall
```

For 24/7 Linux hosting, first validate `warmup:linux`, then move the same services to `systemd` or another restart manager. See [Hosting](docs/operations/hosting.md).

## Policy Modes

- `observe`: log policy decisions only.
- `draft`: generate replies but do not auto-send.
- `auto`: auto-reply only when both global mode and target policy allow it.

Configure profiles and targets in `config/bot-policy.local.json`. Start from `config/bot-policy.example.json`.

The example policy opens inbound visibility with `allowContacts=["*"]` and `allowGroups=true`, but keeps `defaults.mode="observe"`. That means unknown chats are visible to the worker but do not generate replies unless you add a target or intentionally change the defaults.

Profiles default to showing WhatsApp's native typing indicator while an automatic reply is being generated. Disable it per profile with `typing.enabled=false`, or tune the refresh interval with `typing.intervalMs`.

Profiles can opt into structured weather lookup with `tools.weather=true`. The agent can plan a `get_weather` action, then the worker resolves it with Open-Meteo using, in order, WhatsApp shared-location coordinates from OpenClaw metadata, decimal coordinates in the message, or a city/bairro from the planned query. If no location is available, the responder asks for one instead of using web search or guessing.

Profiles can opt into inbound image understanding with `tools.imageUnderstanding=true`. When WhatsApp sends an image with a local `mediaPath`, the worker extracts OCR/visual context before the responder runs and stores the image briefly as a visual reference for that chat. Direct API mode uses `IMAGE_UNDERSTANDING_*`; in local testing, `IMAGE_UNDERSTANDING_PROVIDER=codex-cli` lets Codex read the local image path. If image understanding fails, the worker falls back to a short text explanation instead of silently ignoring the image.

Inbound messages are processed sequentially per WhatsApp conversation. The worker keeps a short multimodal log with text messages, voice transcripts, and recent inbound image references; each response receives that recent context. With `tools.localRead=true`, Codex can inspect local image paths when a later prompt depends on images sent earlier in the chat.

Before tool side effects, the worker asks the agent for a structured action plan. Planned actions include `get_weather`, `generate_image`, `generate_sticker`, and `reply_audio`; the worker still enforces profile opt-in, delivery gates, rate limits, and provider configuration before executing anything.

Profiles can opt into image generation with `tools.imageGeneration=true`. When the agent plans `generate_image`, the worker calls the Image API, saves the generated file under `MEDIA_OUTPUT_DIR`, and sends it through OpenClaw with `openclaw message send --media`. If the planned action sets `useRecentImages=true`, the worker sends up to `MEDIA_REFERENCE_MAX_IMAGES` recent inbound images to the edit/reference endpoint instead of generating from text alone. In direct mode, configure `IMAGE_GENERATOR_API_KEY` or `OPENAI_API_KEY`; in Codex proxy mode, set `CODEX_PROXY_MEDIA_PROVIDER=openai` for upstream pass-through or `CODEX_PROXY_MEDIA_PROVIDER=codex-cli` for local Codex image generation/reference generation.

Profiles can opt into native WhatsApp sticker generation with `tools.stickerGeneration=true`. When the agent plans `generate_sticker`, the worker uses the same image provider, optionally includes recent inbound images as references, asks for a flat `#00ff00` chroma-key source image, removes that key with FFmpeg, cleans transparent pixels with Pillow, writes a 512x512 lossless WebP with exact alpha, and sends it through OpenClaw's WhatsApp `upload-file` gateway action as `asSticker=true`. Run `npm run media:install` for the Pillow dependency. `npm run warmup` reapplies the local OpenClaw WhatsApp sticker patch after plugin install/refresh; configure `MEDIA_FFMPEG_COMMAND` or reuse `CODEX_PROXY_FFMPEG_COMMAND`.

Profiles can opt into audio replies with `voice.reply.enabled=true`. Use `voice.reply.mode="on_request"` to let the agent plan `reply_audio` when the conversation calls for it, or `voice.reply.mode="always"` to deliver every generated text reply as an audio file. In direct mode, configure `SPEECH_API_KEY` or `OPENAI_API_KEY`; in Codex proxy `openai` mode, speech uses the same upstream media provider. In `codex-cli` media mode, speech can use local `System.Speech`, Edge TTS, or Piper through the repo-local TTS adapter and emit Ogg/Opus through the portable FFmpeg installed by `warmup:whisper`. If speech generation fails, the worker falls back to text.

Profiles can opt into retroactive replies with `retroactiveReply.enabled=true`. The worker scans recent OpenClaw history for configured auto-reply targets and answers the latest inbound message that has no later own reply; `retroactiveReply.maxAgeHours` defaults to `12`.

Profiles can also opt into WhatsApp voice-note transcription with `voice.enabled=true`. Defaults keep voice disabled. Direct API mode can transcribe with the same provider credentials; local transcription uses `codex-proxy` plus a `whisper.cpp` server:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_TRANSCRIBER_PROVIDER=local-whisper
WHISPER_LOCAL_ENABLED=true
WHISPER_LOCAL_MODEL=base
```

Run `npm run warmup:whisper` once to download the local binaries/model, or let `npm run warmup` start it when `WHISPER_LOCAL_ENABLED=true`.

See [Voice notes](docs/operations/voice-notes.md) for setup, testing, and troubleshooting.

## Manual Send

```bash
npm run openclaw:send -- --target +15551234567 --message "hello" --verbose
```

Or through the local control daemon:

```bash
curl -X POST http://127.0.0.1:8788/send -H "Content-Type: application/json" -d "{\"target\":\"+15551234567\",\"message\":\"hello\",\"verbose\":true}"
```

## Responder Provider

Default direct API mode:

```text
CODEX_PROXY_ENABLED=false
RESPONDER_BASE_URL=https://api.openai.com/v1
RESPONDER_API_KEY=your-api-key
RESPONDER_MODEL=gpt-4o-mini
```

Optional Codex CLI proxy mode:

```text
CODEX_PROXY_ENABLED=true
RESPONDER_BASE_URL=http://127.0.0.1:8787/v1
RESPONDER_API_KEY=dev-local-change-me
RESPONDER_MODEL=gpt-5.4
```

When `CODEX_PROXY_ENABLED=true` and `CODEX_PROXY_MEDIA_PROVIDER` is enabled, image generation and speech defaults also point at `http://127.0.0.1:8787/v1` unless `IMAGE_GENERATOR_BASE_URL` or `SPEECH_BASE_URL` is set explicitly. Use `CODEX_PROXY_MEDIA_PROVIDER=openai` for upstream pass-through or `CODEX_PROXY_MEDIA_PROVIDER=codex-cli` for local Codex image generation plus local TTS.

See [Codex proxy and responder provider](docs/operations/codex-proxy.md).

## Optional Twilio Sandbox

Twilio support is a helper path for sandbox testing. It reuses the same policy profiles and responder.

```bash
npm run twilio:worker
```

Twilio is not started by `warmup`; run it separately. Expose only `http://127.0.0.1:8791/twilio/whatsapp` through a tunnel and configure that URL as the Twilio inbound webhook. The Twilio worker disables the OpenClaw `/openclaw/message` route on that port. For tunneled testing, keep `TWILIO_VALIDATE_SIGNATURE=true` and set `TWILIO_AUTH_TOKEN` plus `TWILIO_WEBHOOK_URL`. Do not commit real Twilio credentials.

## Docs

- [Architecture](docs/architecture.md)
- [OpenClaw operations](docs/operations/openclaw.md)
- [Guidance profiles](docs/operations/guidance-profiles.md)
- [Codex proxy](docs/operations/codex-proxy.md)
- [Voice notes](docs/operations/voice-notes.md)
- [Hosting](docs/operations/hosting.md)
- [Security](docs/security.md)
- [Product direction](docs/product-direction.md)
