import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './config.js';

// Local text-to-speech for WhatsApp voice replies, invoked directly by the
// worker (no codex-proxy in the path) so the stack ships without any local CLI
// proxy. Uses scripts/local-tts.py (edge-tts, voice pt-BR-FranciscaNeural by
// default) to render mp3, then ffmpeg to the opus/ogg WhatsApp voice format.
// Requires Python + edge-tts + ffmpeg on the host.

export type LocalSpeechResult = { ok: true; path: string } | { ok: false; reason: string };

function runFile(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += error.message;
      clearTimeout(timeout);
      resolve({ status: 1, stdout, stderr });
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        stderr += `${stderr ? '\n' : ''}command timed out after ${timeoutMs}ms`;
      }
      resolve({ status: timedOut ? 1 : status ?? 1, stdout, stderr });
    });
  });
}

async function renderEdgeMp3(
  text: string,
  outputPath: string,
  config: AppConfig['speech']
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const scriptPath = path.resolve(config.ttsScript);
  const inputPath = `${outputPath}.txt`;
  await fs.writeFile(inputPath, text, 'utf8');
  const args = [scriptPath, 'tts', '--text-file', inputPath, '--output', outputPath, '--engine', config.engine];
  if (config.voice) {
    args.push('--voice', config.voice);
  }
  if (config.engine === 'edge') {
    if (config.ttsRate) {
      args.push('--rate', config.ttsRate);
    }
    if (config.ttsPitch) {
      args.push('--pitch', config.ttsPitch);
    }
    if (config.ttsVolume) {
      args.push('--volume', config.ttsVolume);
    }
  }

  try {
    const result = await runFile(config.ttsPython, args, config.timeoutMs, path.dirname(scriptPath));
    if (result.status !== 0) {
      return { ok: false, reason: result.stderr.trim() || result.stdout.trim() || 'local TTS failed' };
    }
    return { ok: true };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => undefined);
  }
}

async function convertToOpus(
  ffmpeg: string,
  inputPath: string,
  outputPath: string,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runFile(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-af',
      'silenceremove=stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-application',
      'voip',
      '-f',
      'ogg',
      outputPath
    ],
    timeoutMs
  );
  if (result.status !== 0) {
    return { ok: false, reason: result.stderr.trim() || `ffmpeg exited with status ${result.status}` };
  }
  return { ok: true };
}

export async function synthesizeLocalSpeech(input: {
  text: string;
  config: AppConfig['speech'];
  outputDir: string;
}): Promise<LocalSpeechResult> {
  if (input.config.engine !== 'edge') {
    return { ok: false, reason: `local speech engine not supported here: ${input.config.engine}` };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-local-tts-'));
  const mp3Path = path.join(runDir, 'speech.mp3');

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const rendered = await renderEdgeMp3(input.text, mp3Path, input.config);
    if (!rendered.ok) {
      return rendered;
    }

    // mp3 plays as a file attachment; opus/ogg is the proper voice-note bubble.
    if (input.config.responseFormat === 'opus') {
      if (!input.config.ffmpegCommand) {
        return { ok: false, reason: 'ffmpeg command not configured for opus voice notes' };
      }
      const outputPath = path.join(input.outputDir, `speech-${timestamp}-${suffix}.opus`);
      const converted = await convertToOpus(input.config.ffmpegCommand, mp3Path, outputPath, input.config.timeoutMs);
      if (!converted.ok) {
        return converted;
      }
      return { ok: true, path: outputPath };
    }

    const outputPath = path.join(input.outputDir, `speech-${timestamp}-${suffix}.mp3`);
    await fs.copyFile(mp3Path, outputPath);
    return { ok: true, path: outputPath };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
