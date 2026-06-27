import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ClaudeRunnerConfig = {
  bin: string;
  model: string;
  effort?: string;
  timeoutMs: number;
  maxPromptChars: number;
  // Claude tools to pre-approve so they run headlessly without a permission
  // prompt (e.g. ['WebSearch']). Empty/undefined means the model answers from
  // its own knowledge with no tool use.
  allowedTools?: string[];
};

export type ClaudeImage = {
  mediaType: string;
  base64: string;
};

export type ClaudeRunInput = {
  // Flattened into --append-system-prompt. The CLI keeps its own base system
  // prompt; this is appended on top.
  systemPrompt?: string;
  userText: string;
  images?: ClaudeImage[];
};

export type ClaudeRunResult = {
  content: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

// Only route through a shell for batch shims (.cmd/.bat). Real executables are
// spawned directly so the large --append-system-prompt argument (with newlines
// and quotes) is passed verbatim instead of being mangled by shell escaping.
function shouldUseShell(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

// On Windows the claude executable can keep a handle on its working directory
// for a short moment after exit, so a single rmdir races with EBUSY/EPERM.
// Cleanup is best-effort: retry a few times, then give up silently rather than
// masking a successful run with a teardown error.
async function removeDirBestEffort(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }

  child.kill('SIGTERM');
}

function imageBlock(image: ClaudeImage) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.base64 }
  };
}

// `--output-format stream-json` prints newline-delimited events; the final
// {type:"result"} event carries the assistant's answer in `.result`. Parse each
// line, prefer the result event, and fall back to concatenated assistant text.
function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('claude returned empty output');
  }

  const events: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) {
      continue;
    }
    try {
      events.push(JSON.parse(text));
    } catch {
      // ignore non-JSON noise
    }
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const obj = events[i];
    if (obj && obj.type === 'result') {
      if (obj.is_error) {
        throw new Error(typeof obj.result === 'string' ? obj.result : 'claude reported an error');
      }
      if (typeof obj.result === 'string') {
        return obj.result.trim();
      }
    }
  }

  // Fallback: concatenate text blocks from assistant message events.
  const textChunks: string[] = [];
  for (const obj of events) {
    const message = obj?.message as { content?: unknown } | undefined;
    if (obj?.type === 'assistant' && Array.isArray(message?.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textChunks.push(block.text);
        }
      }
    }
  }
  if (textChunks.length) {
    return textChunks.join('').trim();
  }

  throw new Error('claude stream contained no result or assistant text');
}

export async function runClaude(input: ClaudeRunInput, config: ClaudeRunnerConfig): Promise<ClaudeRunResult> {
  const systemPrompt = input.systemPrompt?.trim() ?? '';
  const userText = input.userText ?? '';
  const totalChars = userText.length + systemPrompt.length;
  if (totalChars > config.maxPromptChars) {
    throw new Error(`Prompt is too large (${totalChars} chars > ${config.maxPromptChars})`);
  }

  const startedAt = Date.now();
  // Clean cwd so `claude` does not auto-discover the project CLAUDE.md into the
  // model's context.
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-proxy-'));

  const userContent: Array<Record<string, unknown>> = [];
  if (userText.trim()) {
    userContent.push({ type: 'text', text: userText });
  }
  for (const image of input.images ?? []) {
    userContent.push(imageBlock(image));
  }
  if (!userContent.length) {
    userContent.push({ type: 'text', text: '(empty request)' });
  }

  const stdin = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: userContent }
  })}\n`;

  const args = [
    '-p',
    '--model',
    config.model,
    '--input-format',
    'stream-json',
    // stream-json input forces stream-json output, which in turn requires
    // --verbose. We parse the final {type:"result"} event out of the stream.
    '--output-format',
    'stream-json',
    '--verbose',
    '--exclude-dynamic-system-prompt-sections'
  ];
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }
  if (config.effort) {
    args.push('--effort', config.effort);
  }
  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push('--allowedTools', config.allowedTools.join(','));
  }

  let stdout = '';
  let stderr = '';

  try {
    const child = spawn(config.bin, args, {
      cwd: runDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: shouldUseShell(config.bin),
      windowsHide: true
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, config.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // claude may exit before draining stdin (bad model, missing shim, early
    // exit); swallow the resulting EPIPE so it does not become an unhandled
    // stream error that crashes the long-lived proxy. The real failure still
    // surfaces via exitCode/stderr below.
    child.stdin.on('error', () => undefined);
    child.stdin.write(stdin);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    clearTimeout(timeout);

    if (timedOut) {
      throw new Error(`claude timed out after ${config.timeoutMs}ms`);
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `claude exited with status ${exitCode}`;
      throw new Error(detail.slice(0, 2000));
    }

    return {
      content: extractResult(stdout),
      stdout,
      stderr,
      durationMs: Date.now() - startedAt
    };
  } finally {
    await removeDirBestEffort(runDir);
  }
}
