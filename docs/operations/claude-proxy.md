# Claude Proxy

`claude-proxy` backs the WhatsApp worker with the `claude` CLI (Claude Code
subscription) instead of a direct API key or `codex-proxy`. It exposes the local
`claude` CLI as a small OpenAI-compatible Chat Completions endpoint, and the
worker's inbound image understanding runs through the same CLI natively.

It is the sibling of `codex-proxy`. The two are mutually exclusive switches; if
both `CLAUDE_PROXY_ENABLED` and `CODEX_PROXY_ENABLED` are `true`, the Claude
proxy wins.

## What it does (and does not)

The `claude` CLI handles two things natively, and the migration uses it for both:

- **Chat replies** — `POST /v1/chat/completions` runs `claude -p` and returns the
  assistant text. Web search is honored when the worker sets the
  `X-Codex-Proxy-Web-Search: true` header (it pre-approves the `WebSearch` tool).
- **Image understanding / OCR** — inbound WhatsApp images are sent to `claude` as
  a native base64 image block over `--input-format stream-json`. No sandbox and
  no local path juggling, unlike `codex-cli` image understanding.

The `claude` CLI **cannot** generate images, transcribe audio, or synthesize
speech. Those features keep using their own providers:

- Image generation/stickers -> Cloudflare Workers AI (`IMAGE_GENERATOR_PROVIDER=cloudflare`,
  `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, model `flux-1-schnell`). See
  [image-generation.md](./image-generation.md). OpenAI (`gpt-image-1`) is still
  selectable with `IMAGE_GENERATOR_PROVIDER=openai`.
- Transcription -> OpenAI or local Whisper (`TRANSCRIBER_*`, or via codex-proxy).
- Text-to-speech -> OpenAI or local TTS (`SPEECH_*`, or via codex-proxy).

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions` (text + vision; streaming is not implemented)

## Prerequisites

Install Claude Code and log in once:

```bash
claude        # run once interactively
/login        # authenticate the subscription
```

Confirm `claude.exe` (Windows) or `claude` (macOS/Linux) is on `PATH`, or set
`CLAUDE_PROXY_CLAUDE_BIN` to its full path.

## Run it

```bash
npm run claude-proxy        # start the proxy (default 127.0.0.1:8789)
npm run claude-proxy:test   # smoke test -> expects "pong"
```

The worker routes through it when:

```text
CLAUDE_PROXY_ENABLED=true
```

## Config

```text
CLAUDE_PROXY_ENABLED=true
CLAUDE_PROXY_HOST=127.0.0.1
CLAUDE_PROXY_PORT=8789
CLAUDE_PROXY_API_KEY=dev-local-change-me
# sonnet | opus | haiku, or a full claude-* id
CLAUDE_PROXY_MODEL=sonnet
# low|medium|high|xhigh|max (blank = CLI default)
CLAUDE_PROXY_EFFORT=
CLAUDE_PROXY_TIMEOUT_MS=180000
CLAUDE_PROXY_MAX_PROMPT_CHARS=400000
CLAUDE_PROXY_MAX_IMAGE_BYTES=5242880
# CLAUDE_PROXY_CLAUDE_BIN=claude.exe
```

When `CLAUDE_PROXY_ENABLED=true`, the responder defaults to the proxy
(`RESPONDER_BASE_URL=http://127.0.0.1:8789/v1`, model `sonnet`,
key `CLAUDE_PROXY_API_KEY`) and image understanding defaults to provider
`claude-cli`. Override any of `RESPONDER_*` or `IMAGE_UNDERSTANDING_*` to opt out.

## Notes

- A clean temp directory is used as the CLI working directory so the project
  `CLAUDE.md` is not auto-discovered into the model context.
- Requests are serialized (one `claude` run at a time) to keep the local CLI and
  the subscription rate sane.
