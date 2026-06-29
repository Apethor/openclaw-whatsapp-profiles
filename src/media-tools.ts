import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { synthesizeLocalSpeech } from './local-speech.js';

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
};

const STICKER_PREPARE_SCRIPT = fileURLToPath(new URL('../scripts/prepare-sticker-webp.py', import.meta.url));

export type GeneratedMedia = {
  path: string;
};

export type ImageReferenceInput = {
  path?: string;
  url?: string;
  type?: string;
  fileName?: string;
  caption?: string;
  context?: string;
};

export type MediaGenerationResult =
  | { ok: true; media: GeneratedMedia }
  | { ok: false; reason: string };

function referencePromptLines(references: ImageReferenceInput[] | undefined): string[] {
  if (!references?.length) {
    return [];
  }

  const lines = [
    `Use as ${references.length} imagem(ns) de referencia anexadas para entender assunto, pessoa, produto, design, estilo e detalhes visuais relevantes ao pedido.`,
    'Quando as referencias forem da mesma pessoa ou objeto, preserve a identidade visual geral e os tracos consistentes, sem copiar artefatos ruins, fundo ou iluminacao acidental se o pedido pedir outro contexto.'
  ];

  const contextLines = references
    .map((reference, index) => {
      const parts = [
        reference.caption?.trim() ? `legenda: ${reference.caption.trim()}` : undefined,
        reference.context?.trim() ? `contexto visual: ${reference.context.trim().slice(0, 800)}` : undefined
      ].filter(Boolean);
      return parts.length ? `Referencia ${index + 1}: ${parts.join('; ')}` : undefined;
    })
    .filter((line): line is string => Boolean(line));

  if (contextLines.length) {
    lines.push('Contexto extraido das referencias:', ...contextLines);
  }

  return lines;
}

export function imagePromptFromMessage(text: string, references: ImageReferenceInput[] = []): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'Uma paisagem bonita, natural e bem iluminada.';
  }

  return [
    trimmed,
    ...referencePromptLines(references),
    'Crie uma imagem unica e visualmente clara, adequada para enviar em um aplicativo de mensagens.',
    'Nao inclua texto, legenda, marca d agua, logotipos de aplicativos, icones de redes sociais ou elementos de interface dentro da imagem, a menos que o pedido solicite explicitamente.'
  ].join('\n');
}

function softenProtectedFranchiseReferences(text: string): string {
  return text.replace(
    /\bstar\s+wars\b/giu,
    'uma space opera original com naves, planetas deserticos, luas duplas, robos retrofuturistas e aventura galactica, sem personagens, logos ou nomes de franquias'
  );
}

export function stickerPromptFromMessage(text: string, references: ImageReferenceInput[] = []): string {
  const trimmed = text.trim();
  const subject = softenProtectedFranchiseReferences(trimmed) || 'Uma figurinha divertida e simples.';

  return [
    subject,
    ...referencePromptLines(references),
    'Crie uma imagem pensada para virar figurinha (adesivo): composicao quadrada, um assunto principal grande, claro e legivel em 512x512.',
    'Use fundo verde chroma-key perfeitamente plano #00ff00, sem sombras, gradientes ou textura. Nao use verde no assunto principal.',
    'Use alto contraste e contorno ou sombra suave no assunto principal para funcionar bem em tema claro e escuro depois que o fundo for removido.',
    'Nao inclua texto, legenda, marca d agua, logotipos de aplicativos, icones de redes sociais ou elementos de interface dentro da imagem, a menos que o pedido solicite explicitamente.'
  ].join('\n');
}

export function speechTextFromReply(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/`/gu, ' ').replace(/\s+/gu, ' '))
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gmu, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gmu, '')
    .replace(/[ \t]{2,}(?=\n)/gu, '')
    .replace(/[*_~]/gu, '')
    .replace(/\n+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();

  return normalized || text.trim();
}

function extensionForImageFormat(format: AppConfig['imageGenerator']['outputFormat']): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function mediaPath(outputDir: string, prefix: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outputDir, `${prefix}-${timestamp}-${crypto.randomUUID()}.${extension}`);
}

function fileNameForReference(reference: ImageReferenceInput, index: number): string {
  const explicit = reference.fileName?.trim();
  if (explicit) {
    return explicit;
  }

  const fromPath = reference.path ? path.basename(reference.path) : '';
  if (fromPath) {
    return fromPath;
  }

  try {
    const fromUrl = reference.url ? path.basename(new URL(reference.url).pathname) : '';
    if (fromUrl) {
      return fromUrl;
    }
  } catch {
    // Fall through to a generated name.
  }

  return `reference-${index + 1}.png`;
}

function mimeFromReference(reference: ImageReferenceInput): string {
  const explicit = reference.type?.trim();
  if (explicit?.toLowerCase().startsWith('image/')) {
    return explicit;
  }

  const name = (reference.fileName || reference.path || reference.url || '').toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (name.endsWith('.webp')) {
    return 'image/webp';
  }
  if (name.endsWith('.gif')) {
    return 'image/gif';
  }
  if (name.endsWith('.avif')) {
    return 'image/avif';
  }
  return 'image/png';
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function runFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const settle = (status: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // 'error' fires (without a following 'close') when the binary can't even be
    // spawned, e.g. ffmpeg/python missing — resolve here or the caller hangs forever.
    child.on('error', (error: NodeJS.ErrnoException) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      settle(1);
    });
    child.on('close', (status) => {
      if (timedOut) {
        stderr += `${stderr ? '\n' : ''}command timed out after ${timeoutMs}ms`;
      }
      settle(timedOut ? 1 : status ?? 1);
    });
  });
}

function stickerPythonCommand(): string {
  return (
    process.env.MEDIA_STICKER_PYTHON?.trim() ||
    process.env.CODEX_PROXY_LOCAL_TTS_PYTHON?.trim() ||
    'python'
  );
}

async function referenceBlob(
  reference: ImageReferenceInput,
  index: number,
  config: AppConfig['imageGenerator'],
  maxBytes: number
): Promise<{ ok: true; blob: Blob; fileName: string } | { ok: false; reason: string }> {
  if (reference.path) {
    let stat;
    try {
      stat = await fs.stat(reference.path);
    } catch (error) {
      return {
        ok: false,
        reason: `reference image ${index + 1} path unreadable: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (!stat.isFile()) {
      return { ok: false, reason: `reference image ${index + 1} path is not a file` };
    }
    if (stat.size > maxBytes) {
      return { ok: false, reason: `reference image ${index + 1} exceeds max bytes` };
    }

    const buffer = await fs.readFile(reference.path);
    return {
      ok: true,
      blob: new Blob([buffer], { type: mimeFromReference(reference) }),
      fileName: fileNameForReference(reference, index)
    };
  }

  if (reference.url) {
    const response = await fetchWithTimeout(reference.url, { method: 'GET' }, config.timeoutMs);
    if (!response.ok) {
      return { ok: false, reason: `reference image ${index + 1} download failed (${await errorText(response)})` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return { ok: false, reason: `reference image ${index + 1} exceeds max bytes` };
    }

    return {
      ok: true,
      blob: new Blob([buffer], { type: response.headers.get('content-type') ?? mimeFromReference(reference) }),
      fileName: fileNameForReference(reference, index)
    };
  }

  return { ok: false, reason: `reference image ${index + 1} has no path or url` };
}

async function generateImageEditFile(input: {
  prompt: string;
  config: AppConfig['imageGenerator'];
  outputDir: string;
  references: ImageReferenceInput[];
  maxReferenceBytes: number;
}): Promise<MediaGenerationResult> {
  if (!input.config.apiKey) {
    return { ok: false, reason: 'image generator API key not configured' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const form = new FormData();
    form.append('model', input.config.model);
    form.append('prompt', input.prompt);
    form.append('n', '1');
    form.append('size', input.config.size);
    form.append('quality', input.config.quality);
    form.append('output_format', input.config.outputFormat);

    for (const [index, reference] of input.references.entries()) {
      const image = await referenceBlob(reference, index, input.config, input.maxReferenceBytes);
      if (!image.ok) {
        return image;
      }
      form.append('image[]', image.blob, image.fileName);
    }

    const response = await fetchWithTimeout(
      `${input.config.baseUrl.replace(/\/$/, '')}/images/edits`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: form
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `image edit failed (${await errorText(response)})` };
    }

    const data = (await response.json()) as ImageGenerationResponse;
    const image = data.data?.[0];
    const extension = extensionForImageFormat(input.config.outputFormat);
    const outputPath = mediaPath(input.outputDir, 'image-edit', extension);
    if (image?.b64_json) {
      await fs.writeFile(outputPath, Buffer.from(image.b64_json, 'base64'));
      return { ok: true, media: { path: outputPath } };
    }

    if (image?.url) {
      const imageResponse = await fetchWithTimeout(image.url, { method: 'GET' }, input.config.timeoutMs);
      if (!imageResponse.ok) {
        return { ok: false, reason: `image edit download failed (${await errorText(imageResponse)})` };
      }
      await fs.writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
      return { ok: true, media: { path: outputPath } };
    }

    return { ok: false, reason: 'image edit returned no image data' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseImageSize(size: string): { width: number; height: number } {
  const match = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  return { width: 1024, height: 1024 };
}

// Cloudflare's JSON responses carry no mime type, so sniff the magic bytes
// instead of assuming a format; the file extension drives the WhatsApp upload's
// content type.
function imageExtensionFromBytes(buffer: Buffer): string {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return 'jpg';
}

// Cloudflare Workers AI text-to-image. Not OpenAI-compatible: the endpoint is
// .../ai/run/<model> and the response is either JSON with a base64 image (Flux)
// or raw image bytes (SDXL-family), so we branch on the content type. Reference
// image bytes are not sent here; the caller already folds the textual reference
// context into the prompt.
async function generateCloudflareImageFile(input: {
  prompt: string;
  config: AppConfig['imageGenerator'];
  outputDir: string;
}): Promise<MediaGenerationResult> {
  if (!input.config.apiKey) {
    return { ok: false, reason: 'cloudflare image token not configured' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const url = `${input.config.baseUrl.replace(/\/$/, '')}/${input.config.model}`;
    const isFlux = /flux/i.test(input.config.model);
    const { width, height } = parseImageSize(input.config.size);
    const body = isFlux
      ? { prompt: input.prompt, steps: 6 }
      : { prompt: input.prompt, width, height };

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: JSON.stringify(body)
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `image generation failed (${await errorText(response)})` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    let buffer: Buffer;
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as {
        success?: boolean;
        result?: { image?: string };
        errors?: Array<{ code?: number; message?: string }>;
      };
      if (!data.result?.image) {
        // CF returns HTTP 200 with success:false + errors[] for quota/credit/content
        // problems — surface that instead of a generic "no image" message.
        const detail = (data.errors ?? [])
          .map((entry) => entry.message)
          .filter((message): message is string => Boolean(message))
          .join('; ');
        return {
          ok: false,
          reason: detail
            ? `cloudflare image generation returned no image: ${detail}`
            : 'cloudflare image generation returned no image data'
        };
      }
      buffer = Buffer.from(data.result.image, 'base64');
    } else {
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const outputPath = mediaPath(input.outputDir, 'image', imageExtensionFromBytes(buffer));
    await fs.writeFile(outputPath, buffer);
    return { ok: true, media: { path: outputPath } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateImageFile(input: {
  prompt: string;
  config: AppConfig['imageGenerator'];
  outputDir: string;
  references?: ImageReferenceInput[];
  maxReferenceBytes?: number;
}): Promise<MediaGenerationResult> {
  if (!input.config.apiKey) {
    return { ok: false, reason: 'image generator API key not configured' };
  }

  if (input.config.provider === 'cloudflare') {
    return generateCloudflareImageFile({
      prompt: input.prompt,
      config: input.config,
      outputDir: input.outputDir
    });
  }

  if (input.references?.length) {
    return generateImageEditFile({
      prompt: input.prompt,
      config: input.config,
      outputDir: input.outputDir,
      references: input.references,
      maxReferenceBytes: input.maxReferenceBytes ?? 20 * 1024 * 1024
    });
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const response = await fetchWithTimeout(
      `${input.config.baseUrl.replace(/\/$/, '')}/images/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: JSON.stringify({
          model: input.config.model,
          prompt: input.prompt,
          n: 1,
          size: input.config.size,
          quality: input.config.quality,
          output_format: input.config.outputFormat
        })
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `image generation failed (${await errorText(response)})` };
    }

    const data = (await response.json()) as ImageGenerationResponse;
    const image = data.data?.[0];
    const extension = extensionForImageFormat(input.config.outputFormat);
    const outputPath = mediaPath(input.outputDir, 'image', extension);
    if (image?.b64_json) {
      await fs.writeFile(outputPath, Buffer.from(image.b64_json, 'base64'));
      return { ok: true, media: { path: outputPath } };
    }

    if (image?.url) {
      const imageResponse = await fetchWithTimeout(image.url, { method: 'GET' }, input.config.timeoutMs);
      if (!imageResponse.ok) {
        return { ok: false, reason: `image download failed (${await errorText(imageResponse)})` };
      }
      await fs.writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
      return { ok: true, media: { path: outputPath } };
    }

    return { ok: false, reason: 'image generation returned no image data' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function convertImageToStickerFile(input: {
  imagePath: string;
  outputDir: string;
  size: number;
  quality: number;
  timeoutMs: number;
}): Promise<MediaGenerationResult> {
  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const size = Math.max(64, Math.min(1024, Math.round(input.size)));
    const quality = Math.max(1, Math.min(100, Math.round(input.quality)));
    const outputPath = mediaPath(input.outputDir, 'sticker', 'webp');
    // The Python step does the whole job: detect the generated green backdrop, key
    // it out by relative green dominance (robust to the exact tone and brightness
    // gradient the model emits), despill the fringe, then scale + pad to a square
    // transparent WebP. ffmpeg's fixed 0x00ff00 colorkey could not handle the
    // grass-green flux actually produces, which left green halos on the sticker.
    const prepareResult = await runFileWithTimeout(
      stickerPythonCommand(),
      [
        STICKER_PREPARE_SCRIPT,
        input.imagePath,
        outputPath,
        '--size',
        String(size),
        '--quality',
        String(quality),
        '--method',
        '6'
      ],
      input.timeoutMs
    );

    if (prepareResult.status !== 0) {
      return {
        ok: false,
        reason:
          prepareResult.stderr ||
          prepareResult.stdout ||
          `sticker WebP preparation exited with status ${prepareResult.status}`
      };
    }

    return { ok: true, media: { path: outputPath } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function synthesizeSpeechFile(input: {
  text: string;
  config: AppConfig['speech'];
  outputDir: string;
}): Promise<MediaGenerationResult> {
  // Local edge-tts path: rendered directly by the worker (no proxy), so it ships
  // on Proxmox with just Python + edge-tts + ffmpeg.
  if (input.config.provider === 'local') {
    const result = await synthesizeLocalSpeech({
      text: speechTextFromReply(input.text),
      config: input.config,
      outputDir: input.outputDir
    });
    return result.ok ? { ok: true, media: { path: result.path } } : { ok: false, reason: result.reason };
  }

  if (!input.config.apiKey) {
    return { ok: false, reason: 'speech API key not configured' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const speechText = speechTextFromReply(input.text);
    const response = await fetchWithTimeout(
      `${input.config.baseUrl.replace(/\/$/, '')}/audio/speech`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: JSON.stringify({
          model: input.config.model,
          voice: input.config.voice,
          input: speechText,
          response_format: input.config.responseFormat
        })
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `speech generation failed (${await errorText(response)})` };
    }

    const outputPath = mediaPath(input.outputDir, 'speech', input.config.responseFormat);
    await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return { ok: true, media: { path: outputPath } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
