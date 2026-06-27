import http from 'node:http';
import process from 'node:process';
import { pino } from 'pino';
import 'dotenv/config';
import { z } from 'zod';
import { runClaude, type ClaudeImage, type ClaudeRunnerConfig } from './claude-runner.js';

const logger = pino({ level: process.env.BOT_LOG_LEVEL ?? 'info' });

const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8789),
  apiKey: z.string().default('dev-local-change-me'),
  model: z.string().default('sonnet'),
  effort: z.string().optional(),
  timeoutMs: z.coerce.number().int().min(1000).default(180000),
  maxPromptChars: z.coerce.number().int().min(1000).default(400000),
  maxImageBytes: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),
  bin: z.string().default(process.platform === 'win32' ? 'claude.exe' : 'claude')
});

const serverConfig = configSchema.parse({
  host: process.env.CLAUDE_PROXY_HOST,
  port: process.env.CLAUDE_PROXY_PORT,
  apiKey: process.env.CLAUDE_PROXY_API_KEY,
  model: process.env.CLAUDE_PROXY_MODEL,
  effort: process.env.CLAUDE_PROXY_EFFORT,
  timeoutMs: process.env.CLAUDE_PROXY_TIMEOUT_MS,
  maxPromptChars: process.env.CLAUDE_PROXY_MAX_PROMPT_CHARS,
  maxImageBytes: process.env.CLAUDE_PROXY_MAX_IMAGE_BYTES,
  bin: process.env.CLAUDE_PROXY_CLAUDE_BIN
});

const textPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.union([z.string(), z.object({ url: z.string() }).passthrough()]).optional()
  })
  .passthrough();

const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'developer', 'tool']).catch('user'),
      content: z.union([z.string(), z.array(textPartSchema), z.null()]).optional()
    })
  ),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional()
});

type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

const SYSTEM_INSTRUCTION = [
  'You are acting as a local LLM provider behind an OpenAI-compatible Chat Completions API.',
  'The conversation is flattened into a single user turn with [ROLE] markers; any images are attached as native image blocks.',
  'Answer only the user request in a single response. Do not read or edit local files, do not run shell commands.',
  'If the request asks for JSON, return only valid JSON with no prose and no markdown code fences.'
].join(' ');

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next as Promise<T>;
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function isAuthorized(request: http.IncomingMessage): boolean {
  if (!serverConfig.apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${serverConfig.apiKey}`;
}

function headerEnabled(request: http.IncomingMessage, ...names: string[]): boolean {
  return names.some(
    (name) => request.headers[name.toLowerCase()]?.toString().toLowerCase() === 'true'
  );
}

// Skyvern/codex used real OpenAI ids; the claude CLI wants an alias
// (sonnet/opus/haiku) or a full claude-* id. Pass the request model through only
// when it looks like a real claude target, otherwise fall back to the default.
function sanitizeModel(model: string | undefined): string {
  const requested = typeof model === 'string' && model.trim() ? model.trim() : serverConfig.model;
  if (requested === 'claude-proxy' || requested === 'openai-compatible') {
    return serverConfig.model;
  }
  const isAlias = /^(sonnet|opus|haiku)$/i.test(requested);
  const isClaudeId = /^claude[A-Za-z0-9._:-]*$/i.test(requested);
  return isAlias || isClaudeId ? requested : serverConfig.model;
}

function mediaTypeFromMime(mime: string | undefined): string {
  const normalized = (mime || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) {
    return 'image/jpeg';
  }
  if (normalized.includes('webp')) {
    return 'image/webp';
  }
  if (normalized.includes('gif')) {
    return 'image/gif';
  }
  return 'image/png';
}

function blockFromDataUrl(dataUrl: string): ClaudeImage {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  const mediaType = mediaTypeFromMime(match[1] || 'image/png');
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mediaType, base64: buffer.toString('base64') };
}

async function blockFromRemote(url: string): Promise<ClaudeImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Image fetch failed with HTTP ${response.status}`);
    }
    const mediaType = mediaTypeFromMime(response.headers.get('content-type') || 'image/png');
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mediaType, base64: buffer.toString('base64') };
  } finally {
    clearTimeout(timeout);
  }
}

async function imageFrom(imageUrlValue: unknown): Promise<ClaudeImage> {
  const url = typeof imageUrlValue === 'string' ? imageUrlValue : (imageUrlValue as { url?: string })?.url;
  if (!url || typeof url !== 'string') {
    throw new Error('image_url part is missing url');
  }
  if (url.startsWith('data:image/')) {
    return blockFromDataUrl(url);
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return blockFromRemote(url);
  }
  throw new Error('Only data: and http(s): image urls are supported');
}

type ContentPart = z.infer<typeof textPartSchema>;

async function partsToText(
  content: ChatCompletionRequest['messages'][number]['content'],
  images: ClaudeImage[]
): Promise<string> {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }

  const texts: string[] = [];
  for (const part of content as ContentPart[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    if (part.type === 'image_url' || part.image_url) {
      images.push(await imageFrom(part.image_url));
    }
  }
  return texts.join('\n');
}

async function buildPayload(
  request: ChatCompletionRequest
): Promise<{ systemPrompt: string; userText: string; images: ClaudeImage[] }> {
  const systemTexts: string[] = [];
  const userLines: string[] = [];
  const images: ClaudeImage[] = [];

  for (const message of request.messages) {
    const text = (await partsToText(message.content, images)).trim();
    if (message.role === 'system' || message.role === 'developer') {
      if (text) {
        systemTexts.push(text);
      }
      continue;
    }
    if (!text && !images.length) {
      continue;
    }
    if (text) {
      userLines.push(`[${message.role.toUpperCase()}]`, text, '');
    }
  }

  for (const image of images) {
    if (Buffer.byteLength(image.base64, 'base64') > serverConfig.maxImageBytes) {
      throw new Error(`An attached image exceeds ${serverConfig.maxImageBytes} bytes`);
    }
  }

  return {
    systemPrompt: [SYSTEM_INSTRUCTION, ...systemTexts].join('\n\n'),
    userText: userLines.join('\n').trim(),
    images
  };
}

function chatCompletionResponse(model: string, content: string) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_claude_${created}_${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${serverConfig.host}:${serverConfig.port}`}`);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        model: serverConfig.model,
        effort: serverConfig.effort || null,
        bin: serverConfig.bin,
        authEnabled: Boolean(serverConfig.apiKey)
      });
      return;
    }

    if (!isAuthorized(request)) {
      sendJson(response, 401, {
        error: { message: 'Missing or invalid bearer token', type: 'authentication_error' }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: serverConfig.model, object: 'model', owned_by: 'claude-code' }]
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const parsed = chatCompletionRequestSchema.parse(await readJson(request));
      if (parsed.stream) {
        sendJson(response, 400, {
          error: {
            message: 'Streaming is not implemented in the local Claude proxy',
            type: 'invalid_request_error'
          }
        });
        return;
      }

      // Honor the existing responder header (X-Codex-Proxy-Web-Search) so the
      // bot does not need to change; X-Claude-Proxy-Web-Search is also accepted.
      const webSearch = headerEnabled(request, 'x-codex-proxy-web-search', 'x-claude-proxy-web-search');
      const model = sanitizeModel(parsed.model);
      const payload = await buildPayload(parsed);
      const runnerConfig: ClaudeRunnerConfig = {
        bin: serverConfig.bin,
        model,
        effort: serverConfig.effort,
        timeoutMs: serverConfig.timeoutMs,
        maxPromptChars: serverConfig.maxPromptChars,
        allowedTools: webSearch ? ['WebSearch'] : undefined
      };
      const result = await enqueue(() => runClaude(payload, runnerConfig));

      logger.info(
        {
          model,
          webSearch,
          images: payload.images.length,
          durationMs: result.durationMs,
          stdoutBytes: Buffer.byteLength(result.stdout),
          stderrBytes: Buffer.byteLength(result.stderr)
        },
        'claude completion finished'
      );

      sendJson(response, 200, chatCompletionResponse(model, result.content));
      return;
    }

    sendJson(response, 404, {
      error: { message: 'Not found', type: 'invalid_request_error' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'claude proxy request failed');
    sendJson(response, 500, {
      error: { message, type: 'server_error' }
    });
  }
});

server.listen(serverConfig.port, serverConfig.host, () => {
  logger.info(
    {
      url: `http://${serverConfig.host}:${serverConfig.port}`,
      model: serverConfig.model,
      effort: serverConfig.effort || null,
      bin: serverConfig.bin,
      authEnabled: Boolean(serverConfig.apiKey)
    },
    'Claude proxy listening'
  );
});
