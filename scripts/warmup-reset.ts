import process from 'node:process';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import {
  printStatuses,
  stopManaged,
  type ManagedName,
  type ManagedStatus
} from './warmup-utils.js';

const names: ManagedName[] = [
  'whisper-local',
  'openclaw-worker',
  'openclaw-control',
  'openclaw-gateway',
  'codex-proxy',
  'claude-proxy'
];

const ports = [
  ...(process.env.CODEX_PROXY_ENABLED === 'true'
    ? [Number(process.env.CODEX_PROXY_PORT ?? '8787')]
    : []),
  ...(process.env.CLAUDE_PROXY_ENABLED === 'true'
    ? [Number(process.env.CLAUDE_PROXY_PORT ?? '8789')]
    : []),
  ...(process.env.WHISPER_LOCAL_ENABLED === 'true'
    ? [Number(process.env.WHISPER_LOCAL_PORT ?? '2022')]
    : []),
  Number(process.env.OPENCLAW_CONTROL_PORT ?? '8788'),
  Number(process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790'),
  Number(process.env.OPENCLAW_GATEWAY_PORT ?? '18789')
];

async function pidsForPort(port: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const command = [
    `$pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |`,
    'Select-Object -ExpandProperty OwningProcess -Unique;',
    '$pids -join ","'
  ].join(' ');

  const proc = await new Promise<{ stdout: string }>((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    );
    let stdout = '';
    ps.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    ps.on('close', () => resolve({ stdout }));
    ps.on('error', () => resolve({ stdout: '' }));
  });

  return proc.stdout
    .trim()
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
}

function killPid(pid: number): string {
  try {
    process.kill(pid, 'SIGTERM');
    return 'killed';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  const statuses = names.map(stopManaged);
  const portStatuses: ManagedStatus[] = [];

  for (const port of ports) {
    const pids = await pidsForPort(port);
    if (pids.length === 0) {
      portStatuses.push({
        name: 'codex-proxy',
        running: false,
        detail: `port ${port} clear`,
        logPath: ''
      });
      continue;
    }

    for (const pid of pids) {
      portStatuses.push({
        name: 'codex-proxy',
        pid,
        running: false,
        detail: `port ${port}: ${killPid(pid)}`,
        logPath: ''
      });
    }
  }

  printStatuses([...statuses, ...portStatuses]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
