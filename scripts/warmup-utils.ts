import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

export type ManagedName =
  | 'whisper-local'
  | 'codex-proxy'
  | 'claude-proxy'
  | 'openclaw-gateway'
  | 'openclaw-control'
  | 'openclaw-worker';

export type PidInfo = {
  name: ManagedName;
  pid: number;
  command: string;
  args: string[];
  startedAt: string;
  logPath: string;
};

export type ManagedStatus = {
  name: ManagedName;
  pid?: number;
  running: boolean;
  healthy?: boolean;
  detail: string;
  logPath: string;
};

export const runtimeDir = path.resolve('data', 'runtime');

function pidPath(name: ManagedName): string {
  return path.join(runtimeDir, `${name}.pid.json`);
}

export function logPath(name: ManagedName): string {
  return path.join(runtimeDir, `${name}.log`);
}

export function ensureRuntimeDir(): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
}

export function readPidInfo(name: ManagedName): PidInfo | undefined {
  const file = pidPath(name);
  if (!fs.existsSync(file)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PidInfo;
  } catch {
    return undefined;
  }
}

export function writePidInfo(info: PidInfo): void {
  ensureRuntimeDir();
  fs.writeFileSync(pidPath(info.name), JSON.stringify(info, null, 2));
}

export function removePidInfo(name: ManagedName): void {
  fs.rmSync(pidPath(name), { force: true });
}

export function isPidRunning(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnManaged(
  name: ManagedName,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): PidInfo {
  ensureRuntimeDir();
  const output = fs.openSync(logPath(name), 'a');
  const startedAt = new Date().toISOString();
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', 'call', command, ...args], {
          cwd: process.cwd(),
          detached: false,
          env,
          stdio: ['ignore', output, output],
          windowsHide: true
        })
      : spawn(command, args, {
          cwd: process.cwd(),
          detached: true,
          env,
          stdio: ['ignore', output, output]
        });

  child.unref();

  const info = {
    name,
    pid: child.pid ?? 0,
    command,
    args,
    startedAt,
    logPath: logPath(name)
  };
  writePidInfo(info);
  return info;
}

export function spawnManagedDirect(
  name: ManagedName,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): PidInfo {
  ensureRuntimeDir();
  const output = fs.openSync(logPath(name), 'a');
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    env,
    stdio: ['ignore', output, output],
    windowsHide: true
  });

  child.unref();

  const info = {
    name,
    pid: child.pid ?? 0,
    command,
    args,
    startedAt,
    logPath: logPath(name)
  };
  writePidInfo(info);
  return info;
}

export function stopManaged(name: ManagedName): ManagedStatus {
  const info = readPidInfo(name);
  const running = isPidRunning(info?.pid);

  if (!info?.pid || !running) {
    removePidInfo(name);
    return {
      name,
      running: false,
      detail: 'not running',
      logPath: logPath(name)
    };
  }

  if (process.platform === 'win32') {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // Process may have already exited.
    }
  } else {
    process.kill(-info.pid, 'SIGTERM');
  }

  removePidInfo(name);
  return {
    name,
    pid: info.pid,
    running: false,
    detail: 'stopped',
    logPath: info.logPath
  };
}

export function httpOk(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300)));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

export function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export function printStatuses(statuses: ManagedStatus[]): void {
  for (const status of statuses) {
    const pid = status.pid ? ` pid=${status.pid}` : '';
    const health =
      status.healthy === undefined ? '' : status.healthy ? ' healthy=true' : ' healthy=false';
    console.log(`${status.name}: ${status.detail}${pid}${health}`);
    console.log(`  log: ${status.logPath}`);
  }
}
