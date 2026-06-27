import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import 'dotenv/config';

const botModeSchema = z.enum(['observe', 'draft', 'auto']);
const targetModeSchema = z.enum(['observe', 'draft', 'auto']);
const targetTypeSchema = z.enum(['contact', 'group']);

const quietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  end: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  timezone: z.string().default('America/Sao_Paulo')
});

const retroactiveReplySchema = z.object({
  enabled: z.boolean().default(false),
  maxAgeHours: z.number().min(0.1).max(168).default(12)
});

const retroactiveReplyOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  maxAgeHours: z.number().min(0.1).max(168).optional()
});

const voiceReplySchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['on_request', 'always']).default('on_request'),
    includeText: z.boolean().default(false),
    maxChars: z.number().int().min(1).max(4000).default(1000)
  })
  .default({});

const guidanceProfileSchema = z.object({
  label: z.string().optional(),
  language: z.string().default('pt-BR'),
  tone: z.string().default('natural, breve e direto'),
  identityPolicy: z.enum(['masked', 'open']).default('masked'),
  retroactiveReply: retroactiveReplySchema.default({}),
  typing: z
    .object({
      enabled: z.boolean().default(true),
      intervalMs: z.number().int().min(1000).max(30000).default(7000)
    })
    .default({}),
  tools: z
    .object({
      webSearch: z.boolean().default(false),
      localRead: z.boolean().default(false),
      weather: z.boolean().default(false),
      imageUnderstanding: z.boolean().default(false),
      imageGeneration: z.boolean().default(false),
      stickerGeneration: z.boolean().default(false)
    })
    .default({}),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      transcribe: z.boolean().default(true),
      language: z.string().optional(),
      maxAudioBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(25 * 1024 * 1024),
      reply: voiceReplySchema
    })
    .default({}),
  instructions: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  maxResponseChars: z.number().int().min(80).max(4000).default(700)
});

const targetAutoReplySchema = z.object({
  enabled: z.boolean().default(false),
  requireMention: z.boolean().default(true),
  requireDirectReply: z.boolean().default(false),
  maxRepliesPerHour: z.number().int().min(0).max(240).optional()
});

const conversationContextSchema = z.object({
  enabled: z.boolean().default(true),
  maxMessages: z.number().int().min(0).max(50).default(8),
  maxAgeMinutes: z.number().int().min(1).max(10080).default(360),
  includeOwnReplies: z.boolean().default(true)
});

const conversationContextOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  maxMessages: z.number().int().min(0).max(50).optional(),
  maxAgeMinutes: z.number().int().min(1).max(10080).optional(),
  includeOwnReplies: z.boolean().optional()
});

const targetSchema = z.object({
  id: z.string().min(1),
  type: targetTypeSchema,
  label: z.string().optional(),
  openclawTarget: z.string().optional(),
  profile: z.string().default('default'),
  mode: targetModeSchema.default('observe'),
  enabled: z.boolean().default(true),
  autoReply: targetAutoReplySchema.default({}),
  retroactiveReply: retroactiveReplyOverrideSchema.default({}),
  context: conversationContextOverrideSchema.default({})
});

const defaultsSchema = z.object({
  profile: z.string().default('default'),
  mode: targetModeSchema.default('observe')
});

const policySchema = z.object({
  defaults: defaultsSchema.default({}),
  profiles: z
    .record(guidanceProfileSchema)
    .default({
      default: {
        label: 'Default',
        language: 'pt-BR',
        tone: 'natural, breve e direto',
        typing: {
          enabled: true,
          intervalMs: 7000
        },
        instructions: ['Responda como assistente pessoal, sem parecer atendimento comercial.'],
        boundaries: ['Nao assuma compromissos, pagamentos ou decisoes sensiveis sem revisao humana.'],
        maxResponseChars: 700
      }
    }),
  targets: z.array(targetSchema).default([]),
  allowContacts: z.array(z.string()).default([]),
  denyContacts: z.array(z.string()).default([]),
  allowGroups: z.boolean().default(false),
  autoSendContacts: z.array(z.string()).default([]),
  conversationContext: conversationContextSchema.default({}),
  quietHours: quietHoursSchema.default({}),
  maxAutoRepliesPerHour: z.number().int().min(0).max(60).default(5)
});

export type BotMode = z.infer<typeof botModeSchema>;
export type BotPolicy = z.infer<typeof policySchema>;
export type GuidanceProfile = z.infer<typeof guidanceProfileSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;

export type AppConfig = {
  mode: BotMode;
  logLevel: string;
  policyPath: string;
  policy: BotPolicy;
  openclaw: {
    pollIntervalMs: number;
    readLimit: number;
    processExistingMessages: boolean;
  };
  responder: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
  };
  weather: {
    enabled: boolean;
    provider: 'open-meteo';
    forecastBaseUrl: string;
    geocodingBaseUrl: string;
    geocodingLanguage: string;
    geocodingCountryCode?: string;
    timeoutMs: number;
  };
  media: {
    outputDir: string;
    ffmpegCommand?: string;
    referenceMaxImages: number;
    referenceMaxAgeMinutes: number;
    referenceMaxImageBytes: number;
  };
  imageGenerator: {
    provider: 'openai' | 'cloudflare';
    baseUrl: string;
    apiKey?: string;
    model: string;
    size: string;
    quality: string;
    outputFormat: 'png' | 'jpeg' | 'webp';
    timeoutMs: number;
  };
  imageUnderstanding: {
    provider: 'off' | 'openai' | 'custom' | 'codex-cli' | 'claude-cli';
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    maxImageBytes: number;
    detail: 'auto' | 'low' | 'high';
    codexBin: string;
    codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexWorkdir: string;
    claudeBin: string;
    claudeEffort?: string;
    maxPromptChars: number;
  };
  speech: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    voice: string;
    responseFormat: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
    timeoutMs: number;
  };
  sticker: {
    size: number;
    quality: number;
    timeoutMs: number;
  };
  transcriber: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    language?: string;
    prompt?: string;
    timeoutMs: number;
  };
};

const defaultPolicy: BotPolicy = policySchema.parse({});

function resolveOptionalCommand(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')
    ? path.resolve(trimmed)
    : trimmed;
}

function readPolicy(policyPath: string): BotPolicy {
  if (!fs.existsSync(policyPath)) {
    return defaultPolicy;
  }

  const raw = fs.readFileSync(policyPath, 'utf8');
  return policySchema.parse(JSON.parse(raw));
}

export function loadConfig(): AppConfig {
  const policyPath = path.resolve(process.env.BOT_POLICY_PATH ?? './config/bot-policy.local.json');
  const codexProxyHost = process.env.CODEX_PROXY_HOST ?? '127.0.0.1';
  const codexProxyPort = process.env.CODEX_PROXY_PORT ?? '8787';
  const codexProxyEnabled = process.env.CODEX_PROXY_ENABLED === 'true';
  const codexProxyBaseUrl = `http://${codexProxyHost}:${codexProxyPort}/v1`;
  // Claude proxy takes precedence over the codex proxy when both are enabled.
  // The `claude` CLI does chat and vision (image understanding) natively, but
  // cannot generate images, transcribe audio, or synthesize speech — those keep
  // flowing to their direct providers (OpenAI / local Whisper / local TTS).
  const claudeProxyHost = process.env.CLAUDE_PROXY_HOST ?? '127.0.0.1';
  const claudeProxyPort = process.env.CLAUDE_PROXY_PORT ?? '8789';
  const claudeProxyEnabled = process.env.CLAUDE_PROXY_ENABLED === 'true';
  const claudeProxyBaseUrl = `http://${claudeProxyHost}:${claudeProxyPort}/v1`;
  const claudeProxyModel = process.env.CLAUDE_PROXY_MODEL ?? 'sonnet';
  const claudeBinDefault = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const proxyTranscriberProvider = process.env.CODEX_PROXY_TRANSCRIBER_PROVIDER;
  const proxyMediaProvider = process.env.CODEX_PROXY_MEDIA_PROVIDER ?? 'off';
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const directMediaApiKeyDefault = openAiApiKey ?? (codexProxyEnabled ? undefined : process.env.RESPONDER_API_KEY);
  const useCodexProxyMedia = codexProxyEnabled && proxyMediaProvider !== 'off';
  const mediaBaseUrlDefault = useCodexProxyMedia ? codexProxyBaseUrl : 'https://api.openai.com/v1';
  const mediaApiKeyDefault = useCodexProxyMedia ? process.env.CODEX_PROXY_API_KEY : directMediaApiKeyDefault;
  const defaultTranscriberModel =
    proxyTranscriberProvider === 'local-whisper'
      ? process.env.WHISPER_LOCAL_MODEL ?? 'base'
      : 'gpt-4o-mini-transcribe';
  const imageUnderstandingProvider = z
    .enum(['off', 'openai', 'custom', 'codex-cli', 'claude-cli'])
    .parse(
      process.env.IMAGE_UNDERSTANDING_PROVIDER ??
        (claudeProxyEnabled
          ? 'claude-cli'
          : codexProxyEnabled && proxyMediaProvider === 'codex-cli'
            ? 'codex-cli'
            : 'openai')
    );
  const imageUnderstandingTimeoutMs = Number(
    process.env.IMAGE_UNDERSTANDING_TIMEOUT_MS ??
      (imageUnderstandingProvider === 'codex-cli'
        ? process.env.CODEX_PROXY_MEDIA_TIMEOUT_MS ?? process.env.CODEX_PROXY_TIMEOUT_MS ?? '300000'
        : imageUnderstandingProvider === 'claude-cli'
          ? process.env.CLAUDE_PROXY_TIMEOUT_MS ?? '300000'
          : '120000')
  );
  const weatherCountryCode = process.env.WEATHER_GEOCODING_COUNTRY_CODE?.trim().toUpperCase();

  // Image generation: the claude CLI cannot generate images, so when the bot is
  // on the claude backend we generate via Cloudflare Workers AI (its own REST
  // API, not OpenAI-compatible). Auto-selected when Cloudflare creds are present
  // unless IMAGE_GENERATOR_PROVIDER overrides it.
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const cloudflareImageConfigured = Boolean(
    cloudflareAccountId &&
      !cloudflareAccountId.startsWith('PUT-YOUR') &&
      cloudflareApiToken &&
      !cloudflareApiToken.startsWith('PUT-YOUR')
  );
  const imageGeneratorProvider = z
    .enum(['openai', 'cloudflare'])
    .parse(process.env.IMAGE_GENERATOR_PROVIDER ?? (cloudflareImageConfigured ? 'cloudflare' : 'openai'));
  const imageGeneratorSize = process.env.IMAGE_GENERATOR_SIZE ?? '1024x1024';
  const imageGeneratorQuality = process.env.IMAGE_GENERATOR_QUALITY ?? 'low';
  const imageGeneratorOutputFormat = z
    .enum(['png', 'jpeg', 'webp'])
    .parse(process.env.IMAGE_GENERATOR_OUTPUT_FORMAT ?? 'png');
  const imageGeneratorTimeoutMs = Number(process.env.IMAGE_GENERATOR_TIMEOUT_MS ?? '120000');
  const imageGenerator: AppConfig['imageGenerator'] =
    imageGeneratorProvider === 'cloudflare'
      ? {
          provider: 'cloudflare',
          baseUrl:
            process.env.IMAGE_GENERATOR_BASE_URL ??
            `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId ?? ''}/ai/run`,
          // CF uses its own bearer token; never fall back to IMAGE_GENERATOR_API_KEY
          // (an OpenAI key there would be sent as the CF Authorization header).
          apiKey: cloudflareApiToken,
          // Dedicated var so a leftover IMAGE_GENERATOR_MODEL (an OpenAI/codex id)
          // does not leak into the Cloudflare model slug.
          model: process.env.IMAGE_GENERATOR_CLOUDFLARE_MODEL ?? '@cf/black-forest-labs/flux-1-schnell',
          size: imageGeneratorSize,
          quality: imageGeneratorQuality,
          outputFormat: imageGeneratorOutputFormat,
          timeoutMs: imageGeneratorTimeoutMs
        }
      : {
          provider: 'openai',
          baseUrl: process.env.IMAGE_GENERATOR_BASE_URL ?? mediaBaseUrlDefault,
          apiKey: process.env.IMAGE_GENERATOR_API_KEY ?? mediaApiKeyDefault,
          model: process.env.IMAGE_GENERATOR_MODEL ?? 'gpt-image-1-mini',
          size: imageGeneratorSize,
          quality: imageGeneratorQuality,
          outputFormat: imageGeneratorOutputFormat,
          timeoutMs: imageGeneratorTimeoutMs
        };

  return {
    mode: botModeSchema.parse(process.env.BOT_MODE ?? 'observe'),
    logLevel: process.env.BOT_LOG_LEVEL ?? 'info',
    policyPath,
    policy: readPolicy(policyPath),
    openclaw: {
      pollIntervalMs: Number(process.env.OPENCLAW_POLL_INTERVAL_MS ?? '10000'),
      readLimit: Number(process.env.OPENCLAW_READ_LIMIT ?? '10'),
      processExistingMessages: process.env.BOT_PROCESS_EXISTING_MESSAGES === 'true'
    },
    responder: {
      baseUrl:
        process.env.RESPONDER_BASE_URL ??
        (claudeProxyEnabled
          ? claudeProxyBaseUrl
          : codexProxyEnabled
            ? codexProxyBaseUrl
            : 'https://api.openai.com/v1'),
      apiKey:
        process.env.RESPONDER_API_KEY ??
        (claudeProxyEnabled
          ? process.env.CLAUDE_PROXY_API_KEY
          : codexProxyEnabled
            ? process.env.CODEX_PROXY_API_KEY
            : undefined),
      model:
        process.env.RESPONDER_MODEL ??
        (claudeProxyEnabled
          ? claudeProxyModel
          : codexProxyEnabled
            ? process.env.CODEX_PROXY_MODEL ?? 'gpt-5.4'
            : 'gpt-4o-mini'),
      timeoutMs: Number(process.env.RESPONDER_TIMEOUT_MS ?? '120000')
    },
    weather: {
      enabled: process.env.WEATHER_ENABLED !== 'false',
      provider: 'open-meteo',
      forecastBaseUrl: process.env.WEATHER_FORECAST_BASE_URL ?? 'https://api.open-meteo.com',
      geocodingBaseUrl: process.env.WEATHER_GEOCODING_BASE_URL ?? 'https://geocoding-api.open-meteo.com',
      geocodingLanguage: process.env.WEATHER_GEOCODING_LANGUAGE ?? 'pt',
      geocodingCountryCode: weatherCountryCode || undefined,
      timeoutMs: Number(process.env.WEATHER_TIMEOUT_MS ?? '8000')
    },
    media: {
      outputDir: path.resolve(process.env.MEDIA_OUTPUT_DIR ?? './data/generated-media'),
      ffmpegCommand: resolveOptionalCommand(
        process.env.MEDIA_FFMPEG_COMMAND ??
          process.env.CODEX_PROXY_FFMPEG_COMMAND ??
          process.env.WHISPER_LOCAL_FFMPEG_COMMAND
      ),
      referenceMaxImages: Number(process.env.MEDIA_REFERENCE_MAX_IMAGES ?? '5'),
      referenceMaxAgeMinutes: Number(process.env.MEDIA_REFERENCE_MAX_AGE_MINUTES ?? '120'),
      referenceMaxImageBytes: Number(process.env.MEDIA_REFERENCE_MAX_IMAGE_BYTES ?? String(20 * 1024 * 1024))
    },
    imageGenerator,
    imageUnderstanding: {
      provider: imageUnderstandingProvider,
      baseUrl: process.env.IMAGE_UNDERSTANDING_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey:
        process.env.IMAGE_UNDERSTANDING_API_KEY ??
        process.env.OPENAI_API_KEY ??
        (codexProxyEnabled ? undefined : process.env.RESPONDER_API_KEY),
      model:
        process.env.IMAGE_UNDERSTANDING_MODEL ??
        (imageUnderstandingProvider === 'codex-cli'
          ? process.env.CODEX_PROXY_MEDIA_CODEX_MODEL ?? process.env.CODEX_PROXY_MODEL ?? 'gpt-5.4-mini'
          : imageUnderstandingProvider === 'claude-cli'
            ? claudeProxyModel
            : 'gpt-4o-mini'),
      timeoutMs: imageUnderstandingTimeoutMs,
      maxImageBytes: Number(process.env.IMAGE_UNDERSTANDING_MAX_IMAGE_BYTES ?? String(10 * 1024 * 1024)),
      detail: z.enum(['auto', 'low', 'high']).parse(process.env.IMAGE_UNDERSTANDING_DETAIL ?? 'auto'),
      codexBin: process.env.IMAGE_UNDERSTANDING_CODEX_BIN ?? process.env.CODEX_PROXY_CODEX_BIN ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
      codexSandbox: z
        .enum(['read-only', 'workspace-write', 'danger-full-access'])
        .parse(
          process.env.IMAGE_UNDERSTANDING_CODEX_SANDBOX ??
            process.env.CODEX_PROXY_MEDIA_CODEX_SANDBOX ??
            process.env.CODEX_PROXY_SANDBOX ??
            'read-only'
        ),
      codexWorkdir: path.resolve(process.env.IMAGE_UNDERSTANDING_CODEX_WORKDIR ?? process.env.CODEX_PROXY_WORKDIR ?? '.'),
      claudeBin: process.env.IMAGE_UNDERSTANDING_CLAUDE_BIN ?? process.env.CLAUDE_PROXY_CLAUDE_BIN ?? claudeBinDefault,
      claudeEffort: process.env.IMAGE_UNDERSTANDING_CLAUDE_EFFORT ?? process.env.CLAUDE_PROXY_EFFORT,
      maxPromptChars: Number(process.env.IMAGE_UNDERSTANDING_MAX_PROMPT_CHARS ?? process.env.CLAUDE_PROXY_MAX_PROMPT_CHARS ?? process.env.CODEX_PROXY_MAX_PROMPT_CHARS ?? '20000')
    },
    speech: {
      baseUrl: process.env.SPEECH_BASE_URL ?? mediaBaseUrlDefault,
      apiKey: process.env.SPEECH_API_KEY ?? mediaApiKeyDefault,
      model: process.env.SPEECH_MODEL ?? 'gpt-4o-mini-tts',
      voice: process.env.SPEECH_VOICE ?? 'alloy',
      responseFormat: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).parse(process.env.SPEECH_RESPONSE_FORMAT ?? 'mp3'),
      timeoutMs: Number(process.env.SPEECH_TIMEOUT_MS ?? '60000')
    },
    sticker: {
      size: Number(process.env.STICKER_SIZE ?? '512'),
      quality: Number(process.env.STICKER_QUALITY ?? '65'),
      timeoutMs: Number(process.env.STICKER_TIMEOUT_MS ?? '60000')
    },
    transcriber: {
      baseUrl:
        process.env.TRANSCRIBER_BASE_URL ??
        (codexProxyEnabled ? codexProxyBaseUrl : 'https://api.openai.com/v1'),
      apiKey:
        process.env.TRANSCRIBER_API_KEY ??
        (codexProxyEnabled ? process.env.CODEX_PROXY_API_KEY : process.env.RESPONDER_API_KEY),
      model: process.env.TRANSCRIBER_MODEL ?? process.env.CODEX_PROXY_TRANSCRIBER_MODEL ?? defaultTranscriberModel,
      language: process.env.TRANSCRIBER_LANGUAGE,
      prompt: process.env.TRANSCRIBER_PROMPT,
      timeoutMs: Number(process.env.TRANSCRIBER_TIMEOUT_MS ?? '60000')
    }
  };
}
