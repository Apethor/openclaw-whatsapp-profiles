import 'dotenv/config';
import process from 'node:process';
import {
  httpOk,
  isPidRunning,
  logPath,
  printStatuses,
  readPidInfo,
  tcpOpen,
  type ManagedName,
  type ManagedStatus
} from './warmup-utils.js';

const host = process.env.CODEX_PROXY_HOST ?? '127.0.0.1';
const proxyPort = process.env.CODEX_PROXY_PORT ?? '8787';
const claudeProxyHost = process.env.CLAUDE_PROXY_HOST ?? '127.0.0.1';
const claudeProxyPort = process.env.CLAUDE_PROXY_PORT ?? '8789';
const controlPort = process.env.OPENCLAW_CONTROL_PORT ?? '8788';
const hookPort = process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790';
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT ?? '18789');
const whisperHost = process.env.WHISPER_LOCAL_HOST ?? '127.0.0.1';
const whisperPort = Number(process.env.WHISPER_LOCAL_PORT ?? '2022');
const proxyHealthUrl = `http://${host}:${proxyPort}/healthz`;
const claudeProxyHealthUrl = `http://${claudeProxyHost}:${claudeProxyPort}/healthz`;
const controlHealthUrl = `http://127.0.0.1:${controlPort}/healthz`;
const hookHealthUrl = `http://127.0.0.1:${hookPort}/healthz`;
const codexProxyEnabled = process.env.CODEX_PROXY_ENABLED === 'true';
const claudeProxyEnabled = process.env.CLAUDE_PROXY_ENABLED === 'true';
const whisperEnabled = process.env.WHISPER_LOCAL_ENABLED === 'true' || Boolean(readPidInfo('whisper-local'));

async function statusFor(name: ManagedName): Promise<ManagedStatus> {
  if (name === 'codex-proxy' && !codexProxyEnabled) {
    return {
      name,
      running: false,
      healthy: undefined,
      detail: 'disabled CODEX_PROXY_ENABLED=false',
      logPath: logPath(name)
    };
  }

  if (name === 'claude-proxy' && !claudeProxyEnabled) {
    return {
      name,
      running: false,
      healthy: undefined,
      detail: 'disabled CLAUDE_PROXY_ENABLED=false',
      logPath: logPath(name)
    };
  }

  if (name === 'whisper-local' && !whisperEnabled) {
    return {
      name,
      running: false,
      healthy: undefined,
      detail: 'disabled WHISPER_LOCAL_ENABLED=false',
      logPath: logPath(name)
    };
  }

  const info = readPidInfo(name);
  const running = isPidRunning(info?.pid);
  let healthy: boolean | undefined;

  if (name === 'codex-proxy') {
    healthy = await httpOk(proxyHealthUrl);
  } else if (name === 'claude-proxy') {
    healthy = await httpOk(claudeProxyHealthUrl);
  } else if (name === 'whisper-local') {
    healthy = await tcpOpen(whisperHost, whisperPort);
  } else if (name === 'openclaw-control') {
    healthy = await httpOk(controlHealthUrl);
  } else if (name === 'openclaw-gateway') {
    healthy = await tcpOpen('127.0.0.1', gatewayPort);
  } else if (name === 'openclaw-worker') {
    healthy = await httpOk(hookHealthUrl);
  }

  return {
    name,
    pid: info?.pid,
    running,
    healthy,
    detail: running ? 'pid running' : healthy ? 'healthy without pid file' : 'not running',
    logPath: info?.logPath ?? logPath(name)
  };
}

async function main(): Promise<void> {
  const names: ManagedName[] = [
    ...(whisperEnabled ? (['whisper-local'] as ManagedName[]) : []),
    'claude-proxy',
    'codex-proxy',
    'openclaw-gateway',
    'openclaw-control',
    'openclaw-worker'
  ];
  printStatuses(await Promise.all(names.map(statusFor)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
