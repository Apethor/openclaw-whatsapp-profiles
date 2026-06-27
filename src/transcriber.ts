import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, GuidanceProfile } from './config.js';

export type InboundMedia = {
  path?: string;
  url?: string;
  type?: string;
  fileName?: string;
};

export type VoiceTranscriptionResult =
  | {
      ok: true;
      text: string;
      model?: string;
    }
  | {
      ok: false;
      reason: string;
      error?: string;
    };

function isLikelyAudio(media: InboundMedia): boolean {
  return (
    media.type?.toLowerCase().startsWith('audio/') === true ||
    /\.(aac|amr|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(media.fileName ?? media.path ?? '')
  );
}

function fileNameFor(media: InboundMedia): string {
  const fromMedia = media.fileName?.trim();
  if (fromMedia) {
    return fromMedia;
  }

  const fromPath = media.path ? path.basename(media.path) : '';
  if (fromPath) {
    return fromPath;
  }

  return 'voice.ogg';
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function transcribeVoiceMessage(
  media: InboundMedia,
  profile: GuidanceProfile,
  transcriber: AppConfig['transcriber']
): Promise<VoiceTranscriptionResult> {
  if (!profile.voice.enabled) {
    return { ok: false, reason: 'voice disabled for profile' };
  }

  if (!profile.voice.transcribe) {
    return { ok: false, reason: 'voice transcription disabled for profile' };
  }

  if (!media.path) {
    return { ok: false, reason: 'audio media path missing' };
  }

  if (!isLikelyAudio(media)) {
    return { ok: false, reason: 'media is not audio' };
  }

  if (!transcriber.apiKey) {
    return { ok: false, reason: 'transcriber api key missing' };
  }

  let stat;
  try {
    stat = await fs.stat(media.path);
  } catch (error) {
    return {
      ok: false,
      reason: 'audio media path unreadable',
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: 'audio media path is not a file' };
  }

  if (stat.size > profile.voice.maxAudioBytes) {
    return { ok: false, reason: 'audio exceeds profile maxAudioBytes' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), transcriber.timeoutMs);

  try {
    const buffer = await fs.readFile(media.path);

    // Cloudflare Workers AI Whisper is not OpenAI-compatible: POST base64 audio
    // to ai/run/<model> and read result.text.
    if (transcriber.provider === 'cloudflare') {
      const response = await fetch(`${transcriber.baseUrl.replace(/\/$/, '')}/${transcriber.model}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${transcriber.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ audio: buffer.toString('base64') })
      });

      if (!response.ok) {
        return {
          ok: false,
          reason: `transcriber failed (${response.status})`,
          error: await readResponseText(response)
        };
      }

      const data = (await response.json()) as { result?: { text?: unknown } };
      const text = typeof data.result?.text === 'string' ? data.result.text.trim() : '';
      if (!text) {
        return { ok: false, reason: 'transcriber returned empty text' };
      }
      return { ok: true, text, model: transcriber.model };
    }

    const form = new FormData();
    form.append('model', transcriber.model);
    form.append(
      'file',
      new Blob([buffer], { type: media.type ?? 'application/octet-stream' }),
      fileNameFor(media)
    );

    const language = profile.voice.language ?? transcriber.language;
    if (language) {
      form.append('language', language);
    }

    if (transcriber.prompt) {
      form.append('prompt', transcriber.prompt);
    }

    const response = await fetch(
      `${transcriber.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${transcriber.apiKey}`
        },
        body: form
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        reason: `transcriber failed (${response.status})`,
        error: await readResponseText(response)
      };
    }

    const data = (await response.json()) as { text?: unknown; model?: unknown };
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) {
      return { ok: false, reason: 'transcriber returned empty text' };
    }

    return {
      ok: true,
      text,
      model: typeof data.model === 'string' ? data.model : undefined
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'transcription request failed',
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}
