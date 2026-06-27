import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
  ensureRuntimeDir,
  httpOk,
  printStatuses,
  spawnManaged,
  stopManaged,
  tcpOpen,
  waitFor,
  type ManagedName
} from './warmup-utils.js';

const root = process.cwd();
const env = { ...process.env };
const openclawCommand = process.env.OPENCLAW_COMMAND?.trim() || 'openclaw';
const codexProxyEnabled = process.env.CODEX_PROXY_ENABLED === 'true';
const claudeProxyEnabled = process.env.CLAUDE_PROXY_ENABLED === 'true';
const whisperLocalEnabled = process.env.WHISPER_LOCAL_ENABLED === 'true';
const names: ManagedName[] = [
  ...(whisperLocalEnabled ? (['whisper-local'] as ManagedName[]) : []),
  'openclaw-worker',
  'openclaw-control',
  'openclaw-gateway',
  'codex-proxy',
  'claude-proxy'
];

function run(command: string, args: string[], label: string): boolean {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`${label} failed: ${result.error.message}`);
    return false;
  }

  if (result.status !== 0) {
    console.error(`${label} exited with status ${result.status ?? 'unknown'}`);
    return false;
  }

  return true;
}

function inspectWhatsAppPlugin(): boolean {
  const result = spawnSync(openclawCommand, ['plugins', 'inspect', 'whatsapp'], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && /Status:\s*loaded/i.test(output);
}

async function assertPortsClear(): Promise<void> {
  const ports = [
    ...(codexProxyEnabled ? [Number(process.env.CODEX_PROXY_PORT ?? '8787')] : []),
    ...(claudeProxyEnabled ? [Number(process.env.CLAUDE_PROXY_PORT ?? '8789')] : []),
    ...(whisperLocalEnabled ? [Number(process.env.WHISPER_LOCAL_PORT ?? '2022')] : []),
    Number(process.env.OPENCLAW_CONTROL_PORT ?? '8788'),
    Number(process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790'),
    Number(process.env.OPENCLAW_GATEWAY_PORT ?? '18789')
  ];
  let busy: number[] = [];

  const deadline = Date.now() + 5_000;
  do {
    busy = [];
    for (const port of ports) {
      if (await tcpOpen('127.0.0.1', port)) {
        busy.push(port);
      }
    }

    if (busy.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);

  throw new Error(
    `ports still in use after stopping managed processes: ${busy.join(', ')}. ` +
      'Stop the owning processes or run warmup:stop from the same checkout first.'
  );
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.error('warmup:linux is for Linux/Unix hosts. Use npm run warmup on Windows.');
    process.exit(1);
  }

  ensureRuntimeDir();
  printStatuses(names.map(stopManaged));
  await assertPortsClear();

  if (inspectWhatsAppPlugin()) {
    console.log('\nopenclaw whatsapp plugin already installed');
  } else if (
    !run(
      openclawCommand,
      ['plugins', 'install', 'clawhub:@openclaw/whatsapp', '--pin', '--force'],
      'install OpenClaw WhatsApp plugin'
    )
  ) {
    console.error('openclaw whatsapp plugin install failed');
  }

  run('npm', ['run', 'openclaw:patch-whatsapp-stickers'], 'patch OpenClaw WhatsApp sticker support');

  const dispatchPluginPath = path.resolve('openclaw-plugins', 'whatsapp-policy-dispatch');
  if (
    !run(
      openclawCommand,
      ['plugins', 'install', dispatchPluginPath, '--force'],
      'install local OpenClaw dispatch plugin'
    )
  ) {
    console.error('whatsapp-policy-dispatch install failed; auto-reply interception may not run');
  }

  run('npm', ['run', 'openclaw:repair-config'], 'repair OpenClaw config');

  const started = [
    ...(claudeProxyEnabled ? [spawnManaged('claude-proxy', 'npm', ['run', 'claude-proxy'], env)] : []),
    ...(codexProxyEnabled ? [spawnManaged('codex-proxy', 'npm', ['run', 'codex-proxy'], env)] : []),
    spawnManaged(
      'openclaw-gateway',
      openclawCommand,
      ['gateway', 'run', '--force', '--allow-unconfigured'],
      env
    ),
    spawnManaged('openclaw-control', 'npm', ['run', 'openclaw:control'], env),
    spawnManaged('openclaw-worker', 'npm', ['run', 'openclaw:worker'], env)
  ];

  for (const info of started) {
    console.log(`${info.name} started pid=${info.pid} log=${info.logPath}`);
  }
  if (!claudeProxyEnabled) {
    console.log('claude-proxy skipped CLAUDE_PROXY_ENABLED=false');
  }
  if (!codexProxyEnabled) {
    console.log('codex-proxy skipped CODEX_PROXY_ENABLED=false');
  }

  if (whisperLocalEnabled) {
    run('npm', ['run', 'warmup:whisper'], 'start local Whisper');
  } else {
    console.log('whisper-local skipped WHISPER_LOCAL_ENABLED=false');
  }

  const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT ?? '18789');
  await waitFor(() => tcpOpen('127.0.0.1', gatewayPort), 45_000);
  if (codexProxyEnabled) {
    await waitFor(
      () => httpOk(`http://127.0.0.1:${process.env.CODEX_PROXY_PORT ?? '8787'}/healthz`),
      30_000
    );
  }
  if (claudeProxyEnabled) {
    await waitFor(
      () => httpOk(`http://127.0.0.1:${process.env.CLAUDE_PROXY_PORT ?? '8789'}/healthz`),
      30_000
    );
  }
  if (whisperLocalEnabled) {
    await waitFor(
      () => tcpOpen(process.env.WHISPER_LOCAL_HOST ?? '127.0.0.1', Number(process.env.WHISPER_LOCAL_PORT ?? '2022')),
      45_000
    );
  }
  await waitFor(
    () => httpOk(`http://127.0.0.1:${process.env.OPENCLAW_CONTROL_PORT ?? '8788'}/healthz`),
    30_000
  );
  await waitFor(
    () =>
      httpOk(`http://127.0.0.1:${process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790'}/healthz`),
    30_000
  );

  console.log('\nRun: npm run warmup:status');
  run('npm', ['run', 'warmup:status'], 'status');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
