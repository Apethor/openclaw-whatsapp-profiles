# Hosting

This project does not need a public inbound URL for the main OpenClaw WhatsApp flow. It needs a long-running process and persistent local storage for OpenClaw state.

## Recommended Order

| Option | Fit | Notes |
|---|---|---|
| Local machine | Best for development | Easy to debug, not ideal for 24/7. |
| Home mini-server | Best personal 24/7 path | Persistent disk, no public port required. |
| Small VPS | Good simple production path | Predictable, usually cheap, not free. |
| Always-free VM | Possible | Watch billing, capacity, disk persistence, and region limits. |
| Free PaaS | Avoid for the main worker | Sleep/scale-to-zero breaks always-on WhatsApp sessions. |

## Requirements

- Node.js 20+.
- Persistent filesystem.
- Process restart manager.
- Logs under `data/runtime/`.
- No public inbound ports for the core WhatsApp flow.
- Private tunnel only if you enable optional webhook helpers such as Twilio.

## Operations

Windows uses the PowerShell warmup manager:

```bash
npm run warmup
npm run warmup:status
```

To start the Windows stack automatically after your user logs in, install the scheduled task:

```bash
npm run service:install
npm run service:status
```

This uses the same `start-chatbot.ps1` launcher in non-interactive mode and writes startup output to `data/runtime/start-chatbot.log`. To trigger it immediately or remove it:

```bash
npm run service:run
npm run service:uninstall
```

Linux, Orange Pi, and VPS hosts can use the Linux warmup manager:

```bash
npm run warmup:linux
npm run warmup:status
```

`warmup:linux` stops only processes that were previously started by this checkout and recorded under `data/runtime/`. If another process owns one of the project ports, it fails instead of killing unknown processes.

For a long-running Linux install, validate the warmup path first, then use a process manager such as `systemd` or `pm2` to run the same underlying services explicitly:

```bash
npm run openclaw:control
npm run openclaw:worker
openclaw gateway run --force --allow-unconfigured
```

If `CODEX_PROXY_ENABLED=true`, also run:

```bash
npm run codex-proxy
```

If `WHISPER_LOCAL_ENABLED=true`, also run:

```bash
npm run warmup:whisper
```

Run `npm run openclaw:install-dispatch-plugin` and `npm run openclaw:repair-config` during setup or whenever plugin/config policy changes.

Keep `.env`, `data/`, and `config/bot-policy.local.json` on persistent storage and out of git.

## Linux Host Notes

Orange Pi is a good first 24/7 target if it has stable power, reliable storage, and enough RAM for Codex/OpenClaw. A small VPS is cleaner operationally, but it is not necessarily safer: the WhatsApp session files and policy config still become sensitive server data.

Avoid free PaaS workers for the main WhatsApp flow. Sleep, ephemeral disks, and scale-to-zero behavior can break the WhatsApp session. Always-free VMs can work, but only if disk persistence and background process limits are clear.

For a Linux service manager, keep these files/directories persistent:

```bash
.env
config/bot-policy.local.json
data/
~/.openclaw/
```
