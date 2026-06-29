import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { loadConfig, type AppConfig, type TargetConfig } from './config.js';
import { decideDelivery } from './delivery-gate.js';
import { resolveConversationContext, resolveGuidance } from './guidance.js';
import {
  buildImageUnderstandingMessage,
  fallbackImageUnderstandingMessage,
  isLikelyImageMedia,
  understandImageMessage
} from './image-understanding.js';
import {
  convertImageToStickerFile,
  generateImageFile,
  type ImageReferenceInput,
  imagePromptFromMessage,
  stickerPromptFromMessage,
  synthesizeSpeechFile
} from './media-tools.js';
import { sendOpenClawMediaAsync, sendOpenClawStickerAsync, toOpenClawTarget } from './openclaw-cli.js';
import { decideMessageAction } from './policy.js';
import { generateActionPlan, generateDraftReply, type AgentAction } from './responder.js';
import { hasRetroactiveReplyTargets, runRetroactiveReplyScan } from './retroactive-replies.js';
import {
  getConversationContext,
  getRecentImageReferences,
  hasSeen,
  isRecentOutbound,
  loadRuntimeState,
  markSeen,
  countRecentOutbound,
  rememberImageReference,
  rememberConversationEntry,
  rememberOutbound,
  saveRuntimeState
} from './runtime-state.js';
import { type InboundMedia, transcribeVoiceMessage } from './transcriber.js';
import { resolveWeatherPromptContext } from './weather.js';
import { resolveWebSearchPromptContext } from './web-search.js';

type InboundPayload = {
  type?: string;
  action?: string;
  sessionKey?: string;
  timestamp?: string | number;
  context?: {
    from?: string;
    content?: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  };
};

type InboundMessage = {
  id: string;
  remoteJid: string;
  text: string;
  inputKind: 'text' | 'voice' | 'media';
  raw: InboundPayload;
  media?: InboundMedia;
  mediaCaption?: string;
  imageContext?: string;
};

type TypingPolicyResult = {
  ok: true;
  action: 'ignored' | 'observe' | 'draft' | 'auto' | 'blocked';
  enabled: boolean;
  intervalMs: number;
  profile?: string;
  reasons?: string[];
};

type InboundSeed = {
  id: string;
  remoteJid: string;
  text?: string;
  transcript?: string;
  media?: InboundMedia;
  raw: InboundPayload;
};

const startupConfig = loadConfig();
const logger = pino({ level: startupConfig.logLevel });
const host = process.env.WHATSAPP_ASSISTANT_HOOK_HOST ?? '127.0.0.1';
const port = Number(process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790');
const twilioWebhookPath = process.env.TWILIO_WEBHOOK_PATH ?? '/twilio/whatsapp';
const validateTwilioSignature = process.env.TWILIO_VALIDATE_SIGNATURE === 'true';
const twilioOnly = process.env.WHATSAPP_ASSISTANT_TWILIO_ONLY === 'true';
const workerProcessName = process.env.WORKER_PROCESS_NAME ?? 'openclaw-worker';
const workerProcessArgs = (process.env.WORKER_PROCESS_ARGS ?? 'run openclaw:worker').split(' ');
const workerPidPath = path.resolve('data', 'runtime', `${workerProcessName}.pid.json`);
const logReplyContent = process.env.BOT_LOG_REPLY_CONTENT === 'true';
let retroactiveReplyScanInFlight = false;
const inboundQueues = new Map<string, Promise<unknown>>();

function registerWorkerProcess(): void {
  const runtimeDir = path.dirname(workerPidPath);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    workerPidPath,
    JSON.stringify(
      {
        name: workerProcessName,
        pid: process.pid,
        command: 'npm',
        args: workerProcessArgs,
        startedAt: new Date().toISOString(),
        logPath: path.join(runtimeDir, `${workerProcessName}.log`)
      },
      null,
      2
    )
  );
}

function startRetroactiveReplyScanner(): void {
  const intervalMs = Number.isFinite(startupConfig.openclaw.pollIntervalMs)
    ? Math.max(5000, startupConfig.openclaw.pollIntervalMs)
    : 10000;

  const runScan = async (): Promise<void> => {
    const config = loadConfig();
    if (!hasRetroactiveReplyTargets(config)) {
      return;
    }

    if (retroactiveReplyScanInFlight) {
      logger.debug('retroactive reply scan skipped because previous scan is still running');
      return;
    }

    retroactiveReplyScanInFlight = true;
    try {
      await runRetroactiveReplyScan(config, logger);
    } finally {
      retroactiveReplyScanInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void runScan().catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'retroactive reply scan failed'
      );
    });
  }, intervalMs);
  timer.unref?.();
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    const stringValue = getString(value);
    if (stringValue) {
      return stringValue;
    }

    const arrayValue = getStringArray(value)[0];
    if (arrayValue) {
      return arrayValue;
    }
  }

  return undefined;
}

function normalizeContact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits) {
    return `${digits}@s.whatsapp.net`;
  }

  return trimmed;
}

function groupJidFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = sessionKey?.match(/(?:^|:)group:([^:]+@g\.us)(?:$|:)/);
  return match?.[1];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectInboundIds(payload: InboundPayload): string[] {
  const metadata = payload.context?.metadata ?? {};
  const sessionGroupJid = groupJidFromSessionKey(payload.sessionKey);
  const isGroup = metadata.isGroup === true || Boolean(sessionGroupJid);
  const chatIds = [
    sessionGroupJid,
    getString(metadata.remoteJid),
    getString(metadata.chatId),
    getString(metadata.conversationId),
    getString(metadata.openclawConversationId),
    getString(metadata.jid),
    payload.context?.from
  ];
  const senderIds = [
    getString(metadata.senderId),
    getString(metadata.senderE164),
    getString(metadata.from),
    getString(metadata.participant)
  ];

  return uniqueStrings(
    (isGroup ? [...chatIds, ...senderIds] : [...senderIds, ...chatIds])
      .filter((value): value is string => Boolean(value))
      .map(normalizeContact)
  );
}

function targetMatchesId(target: TargetConfig, id: string): boolean {
  const targetIds = [
    normalizeContact(target.id),
    target.openclawTarget ? normalizeContact(target.openclawTarget) : undefined
  ].filter((value): value is string => Boolean(value));

  return targetIds.includes(id);
}

function findTarget(payload: InboundPayload, config: AppConfig): TargetConfig | undefined {
  const ids = collectInboundIds(payload);
  for (const id of ids) {
    const target = config.policy.targets.find((candidate) => candidate.enabled && targetMatchesId(candidate, id));
    if (target) {
      return target;
    }
  }

  return undefined;
}

function resolveRemoteJid(payload: InboundPayload, target: TargetConfig | undefined): string | undefined {
  if (target) {
    return target.id;
  }

  return collectInboundIds(payload)[0];
}

function isMediaPlaceholder(text: string | undefined): boolean {
  return /^<media:[a-z0-9_-]+>$/i.test(text?.trim() ?? '');
}

function isAudioPlaceholder(text: string | undefined): boolean {
  return /^<media:audio>$/i.test(text?.trim() ?? '');
}

function collectInboundMedia(payload: InboundPayload): InboundMedia | undefined {
  const metadata = payload.context?.metadata ?? {};
  const mediaPath = firstString(
    metadata.mediaPath,
    metadata.MediaPath,
    metadata.mediaPaths,
    metadata.MediaPaths,
    metadata.filePath,
    metadata.FilePath,
    metadata.path
  );
  const mediaUrl = firstString(metadata.mediaUrl, metadata.MediaUrl, metadata.mediaUrls, metadata.MediaUrls, metadata.fileUrl);
  const mediaType = firstString(
    metadata.mediaType,
    metadata.MediaType,
    metadata.mediaTypes,
    metadata.MediaTypes,
    metadata.mimeType,
    metadata.mimetype,
    metadata.contentType
  );
  const mediaFileName = firstString(metadata.mediaFileName, metadata.MediaFileName, metadata.fileName, metadata.filename);

  if (!mediaPath && !mediaUrl && !mediaType && !mediaFileName) {
    return undefined;
  }

  return {
    path: mediaPath,
    url: mediaUrl,
    type: mediaType,
    fileName: mediaFileName
  };
}

function normalizeInboundSeed(payload: InboundPayload, remoteJid: string): InboundSeed | undefined {
  const metadata = payload.context?.metadata ?? {};
  const text = payload.context?.content?.trim();
  const transcript = firstString(metadata.transcript, metadata.Transcript)?.trim();
  const media = collectInboundMedia(payload);

  if (!text && !transcript && !media) {
    return undefined;
  }

  const id =
    getString(metadata.messageId) ??
    getString(metadata.id) ??
    getString(metadata.stanzaId) ??
    `${payload.sessionKey ?? remoteJid}:${payload.timestamp ?? Date.now()}:${text ?? transcript ?? media?.path ?? media?.url ?? 'media'}`;

  return {
    id,
    remoteJid,
    text,
    transcript,
    media,
    raw: payload
  };
}

function isAudioSeed(seed: InboundSeed): boolean {
  return (
    isAudioPlaceholder(seed.text) ||
    seed.media?.type?.toLowerCase().startsWith('audio/') === true ||
    /\.(aac|amr|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(seed.media?.fileName ?? seed.media?.path ?? '')
  );
}

function seedHasText(seed: InboundSeed): boolean {
  return Boolean(seed.text && !isMediaPlaceholder(seed.text));
}

function fallbackVoiceText(reason: string): string {
  return [
    '[Audio recebido, mas nao foi possivel ouvir ou transcrever com seguranca.]',
    `Motivo tecnico resumido: ${reason}.`,
    'Responda de forma natural pedindo para a pessoa reenviar por texto, sem mencionar sistema, API, modelo ou automacao.'
  ].join(' ');
}

function typingPolicyDisabled(
  intervalMs: number,
  action: TypingPolicyResult['action'],
  reason: string,
  profile?: string
): TypingPolicyResult {
  return {
    ok: true,
    action,
    enabled: false,
    intervalMs,
    profile,
    reasons: [reason]
  };
}

function seedCanProduceReply(seed: InboundSeed, config: AppConfig): { ok: true } | { ok: false; reason: string } {
  if (seed.transcript || seedHasText(seed)) {
    return { ok: true };
  }

  if (!seed.media && !isMediaPlaceholder(seed.text)) {
    return { ok: false, reason: 'empty message' };
  }

  if (!isAudioSeed(seed)) {
    const guidance = resolveGuidance(seed.remoteJid, config.policy);
    if (isLikelyImageMedia(seed.media) && guidance.profile.tools.imageUnderstanding) {
      return { ok: true };
    }
    return { ok: false, reason: 'non-audio media message' };
  }

  const guidance = resolveGuidance(seed.remoteJid, config.policy);
  if (!guidance.profile.voice.enabled || !guidance.profile.voice.transcribe) {
    return { ok: false, reason: 'voice disabled for profile' };
  }

  return { ok: true };
}

async function resolveMessageFromSeed(
  seed: InboundSeed,
  config: AppConfig
): Promise<InboundMessage | { ignored: true; reason: string }> {
  const guidance = resolveGuidance(seed.remoteJid, config.policy);

  if (seed.transcript) {
    return {
      id: seed.id,
      remoteJid: seed.remoteJid,
      text: seed.transcript,
      inputKind: 'voice',
      raw: seed.raw,
      media: seed.media
    };
  }

  if (isLikelyImageMedia(seed.media)) {
    if (guidance.profile.tools.imageUnderstanding) {
      const result = await understandImageMessage({
        media: seed.media ?? {},
        caption: seed.text,
        profile: guidance.profile,
        config: config.imageUnderstanding
      });

      if (!result.ok) {
        logger.warn(
          { remoteJid: seed.remoteJid, provider: config.imageUnderstanding.provider, reason: result.reason },
          'image understanding failed; using text fallback'
        );
      }

      return {
        id: seed.id,
        remoteJid: seed.remoteJid,
        text: result.ok
          ? buildImageUnderstandingMessage({
              caption: seed.text,
              imageContext: result.text
            })
          : fallbackImageUnderstandingMessage(result.reason, seed.text),
        inputKind: 'media',
        raw: seed.raw,
        media: seed.media,
        mediaCaption: seed.text,
        imageContext: result.ok ? result.text : undefined
      };
    }

    if (!seedHasText(seed)) {
      return { ignored: true, reason: 'image understanding disabled for profile' };
    }
  }

  if (seedHasText(seed)) {
    return {
      id: seed.id,
      remoteJid: seed.remoteJid,
      text: seed.text?.trim() ?? '',
      inputKind: 'text',
      raw: seed.raw,
      media: seed.media
    };
  }

  if (!seed.media && !isMediaPlaceholder(seed.text)) {
    return { ignored: true, reason: 'empty message' };
  }

  if (!isAudioSeed(seed)) {
    return { ignored: true, reason: 'non-audio media message' };
  }

  if (!guidance.profile.voice.enabled || !guidance.profile.voice.transcribe) {
    return { ignored: true, reason: 'voice disabled for profile' };
  }

  const result = await transcribeVoiceMessage(seed.media ?? {}, guidance.profile, config.transcriber);
  if (result.ok) {
    return {
      id: seed.id,
      remoteJid: seed.remoteJid,
      text: result.text,
      inputKind: 'voice',
      raw: seed.raw,
      media: seed.media
    };
  }

  logger.warn(
    { remoteJid: seed.remoteJid, provider: config.transcriber.provider, reason: result.reason },
    'voice transcription failed; using text fallback'
  );

  return {
    id: seed.id,
    remoteJid: seed.remoteJid,
    text: fallbackVoiceText(result.reason),
    inputKind: 'voice',
    raw: seed.raw,
    media: seed.media
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
}

async function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendXml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/xml; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwilioResponse(reply?: string): string {
  if (!reply) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
}

function formToRecord(form: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    record[key] = value;
  }
  return record;
}

function getRequestPath(request: http.IncomingMessage): string {
  return new URL(request.url ?? '/', `http://${host}:${port}`).pathname;
}

function getTwilioWebhookUrl(request: http.IncomingMessage): string | undefined {
  const configuredUrl = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const forwardedHost = request.headers['x-forwarded-host']?.toString().split(',')[0]?.trim();
  const hostHeader = forwardedHost || request.headers.host;
  if (!hostHeader) {
    return undefined;
  }

  const forwardedProto = request.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
  const protocol = forwardedProto || 'https';
  return `${protocol}://${hostHeader}${request.url ?? twilioWebhookPath}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidTwilioSignature(request: http.IncomingMessage, form: URLSearchParams): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers['x-twilio-signature']?.toString();
  const webhookUrl = getTwilioWebhookUrl(request);
  if (!authToken || !signature || !webhookUrl) {
    return false;
  }

  const signedPayload = [...form.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce((payload, [key, value]) => `${payload}${key}${value}`, webhookUrl);

  const expected = crypto.createHmac('sha1', authToken).update(signedPayload).digest('base64');
  return safeEqual(expected, signature);
}

function twilioFormToInboundPayload(form: URLSearchParams): InboundPayload {
  const data = formToRecord(form);
  const messageId = data.MessageSid || data.SmsMessageSid || data.SmsSid;

  return {
    type: 'message',
    action: 'received',
    sessionKey: 'twilio',
    timestamp: new Date().toISOString(),
    context: {
      from: data.From,
      content: data.Body,
      channelId: 'whatsapp',
      metadata: {
        provider: 'twilio',
        messageId,
        smsMessageSid: data.SmsMessageSid,
        smsSid: data.SmsSid,
        messageSid: data.MessageSid,
        accountSid: data.AccountSid,
        from: data.From,
        to: data.To,
        waId: data.WaId,
        profileName: data.ProfileName,
        messageType: data.MessageType,
        numMedia: data.NumMedia,
        mediaUrl: data.MediaUrl0,
        mediaType: data.MediaContentType0
      }
    }
  };
}

function isTwilioSandboxDefaultEcho(text: string): boolean {
  return (
    text.startsWith('You said :') &&
    text.includes("Configure your WhatsApp Sandbox's Inbound URL to change this message.")
  );
}

function replyFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const action = 'action' in result ? result.action : undefined;
  const reply = 'reply' in result ? result.reply : undefined;
  return action === 'reply' && typeof reply === 'string' && reply.length > 0 ? reply : undefined;
}

function canSendOpenClawMedia(payload: InboundPayload): boolean {
  return payload.sessionKey !== 'twilio' && payload.context?.channelId === 'whatsapp';
}

function openClawTargetForMessage(message: InboundMessage, target: TargetConfig | undefined): string {
  return toOpenClawTarget(target?.id ?? message.remoteJid, target?.openclawTarget);
}

// Internal failure reasons can carry full provider dumps (CLI preambles,
// session ids, internal URLs, echoed prompts). Even in "open" identity profiles
// the user-facing reply must never leak those: keep only a short first-line
// summary, drop any "(technical detail)" tail, strip URLs, and cap the length.
function summarizeFailureReason(reason: string): string {
  const firstLine = reason.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  let summary = firstLine
    .split(' (')[0]
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (summary.length > 120) {
    summary = `${summary.slice(0, 117)}...`;
  }
  return summary || 'erro interno';
}

function userVisibleMediaFailure(
  reason: string,
  identityPolicy: 'masked' | 'open',
  kind: 'audio' | 'image' | 'sticker'
): string {
  if (identityPolicy === 'open') {
    const summary = summarizeFailureReason(reason);
    if (kind === 'image') {
      return `Nao consegui gerar/enviar a imagem agora (${summary}).`;
    }
    if (kind === 'sticker') {
      return `Nao consegui gerar/enviar a figurinha agora (${summary}).`;
    }
    return `Nao consegui enviar em audio agora (${summary}). Vou mandar em texto.`;
  }

  if (kind === 'image') {
    return 'Nao consegui gerar a imagem agora.';
  }
  if (kind === 'sticker') {
    return 'Nao consegui gerar a figurinha agora.';
  }
  return 'Nao consegui mandar em audio agora. Vai por texto mesmo.';
}

function rememberInboundImageReference(
  state: ReturnType<typeof loadRuntimeState>,
  message: InboundMessage
): boolean {
  if (!isLikelyImageMedia(message.media)) {
    return false;
  }

  rememberImageReference(state, message.remoteJid, {
    id: message.id,
    path: message.media?.path,
    url: message.media?.url,
    type: message.media?.type,
    fileName: message.media?.fileName,
    caption: message.mediaCaption,
    context: message.imageContext
  });
  return true;
}

function recentImageReferencesForPrompt(
  state: ReturnType<typeof loadRuntimeState>,
  message: InboundMessage,
  config: AppConfig
): ImageReferenceInput[] {
  return getRecentImageReferences(state, message.remoteJid, {
    maxImages: config.media.referenceMaxImages,
    maxAgeMinutes: config.media.referenceMaxAgeMinutes
  }).map((reference) => ({
    path: reference.path,
    url: reference.url,
    type: reference.type,
    fileName: reference.fileName,
    caption: reference.caption,
    context: reference.context
  }));
}

function firstPlannedAction<T extends AgentAction['type']>(
  actions: AgentAction[],
  type: T
): Extract<AgentAction, { type: T }> | undefined {
  return actions.find((action): action is Extract<AgentAction, { type: T }> => action.type === type);
}

function promptFromPlannedAction(
  action: Extract<AgentAction, { type: 'generate_image' | 'generate_sticker' }>,
  fallback: string
): string {
  return action.prompt?.trim() || fallback;
}

function inboundQueueKey(payload: InboundPayload): string {
  const config = loadConfig();
  const target = findTarget(payload, config);
  return resolveRemoteJid(payload, target) ?? payload.sessionKey ?? payload.context?.from ?? 'unknown';
}

function enqueueInboundByTarget(payload: InboundPayload): Promise<unknown> {
  const key = inboundQueueKey(payload);
  const previous = inboundQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => handleInbound(payload));
  const tracked = next.finally(() => {
    if (inboundQueues.get(key) === tracked) {
      inboundQueues.delete(key);
    }
  });
  inboundQueues.set(key, tracked);
  return next;
}

function resolveTypingPolicyForInbound(payload: InboundPayload): TypingPolicyResult {
  const config = loadConfig();

  if (payload.context?.channelId !== 'whatsapp') {
    return typingPolicyDisabled(7000, 'ignored', 'not whatsapp');
  }

  const target = findTarget(payload, config);
  const remoteJid = resolveRemoteJid(payload, target);
  if (!remoteJid) {
    return typingPolicyDisabled(7000, 'ignored', 'sender not detected');
  }

  const guidance = resolveGuidance(remoteJid, config.policy);
  const intervalMs = guidance.profile.typing.intervalMs;
  const profile = guidance.profileName;
  const seed = normalizeInboundSeed(payload, remoteJid);
  if (!seed) {
    return typingPolicyDisabled(intervalMs, 'ignored', 'empty message', profile);
  }

  if (seedHasText(seed) && isTwilioSandboxDefaultEcho(seed.text ?? '')) {
    return typingPolicyDisabled(intervalMs, 'ignored', 'twilio sandbox default echo', profile);
  }

  const state = loadRuntimeState();
  if (hasSeen(state, seed.remoteJid, seed.id)) {
    return typingPolicyDisabled(intervalMs, 'ignored', 'duplicate message', profile);
  }

  if (seedHasText(seed) && isRecentOutbound(state, seed.remoteJid, seed.text ?? '')) {
    return typingPolicyDisabled(intervalMs, 'ignored', 'recent outbound echo', profile);
  }

  const decision = decideMessageAction(seed.remoteJid, config.mode, config.policy);
  if (decision.action !== 'auto') {
    return {
      ok: true,
      action: decision.action === 'ignore' ? 'ignored' : decision.action,
      enabled: false,
      intervalMs,
      profile: decision.profile ?? profile,
      reasons: decision.reasons
    };
  }

  const replyReadiness = seedCanProduceReply(seed, config);
  if (!replyReadiness.ok) {
    return typingPolicyDisabled(intervalMs, 'ignored', replyReadiness.reason, profile);
  }

  const delivery = decideDelivery(config.policy, target);
  if (!delivery.allowed) {
    return {
      ok: true,
      action: 'blocked',
      enabled: false,
      intervalMs,
      profile: decision.profile ?? profile,
      reasons: delivery.reasons
    };
  }

  const hourlyLimit = target?.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
  const recentAutoReplies = countRecentOutbound(state, seed.remoteJid, 60 * 60 * 1000);
  if (recentAutoReplies >= hourlyLimit) {
    return typingPolicyDisabled(
      intervalMs,
      'blocked',
      `max auto replies per hour reached (${hourlyLimit})`,
      decision.profile ?? profile
    );
  }

  return {
    ok: true,
    action: 'auto',
    enabled: guidance.profile.typing.enabled,
    intervalMs,
    profile: decision.profile ?? profile,
    reasons: guidance.profile.typing.enabled ? ['typing indicator enabled'] : ['typing indicator disabled for profile']
  };
}

async function handleInbound(payload: InboundPayload): Promise<unknown> {
  const handlerStartedAt = Date.now();
  const config = loadConfig();

  if (payload.context?.channelId !== 'whatsapp') {
    return { ok: true, action: 'ignored', reason: 'not whatsapp' };
  }

  const target = findTarget(payload, config);
  const remoteJid = resolveRemoteJid(payload, target);
  if (!remoteJid) {
    logger.info(
      { from: payload.context?.from, metadata: payload.context?.metadata },
      'inbound whatsapp message did not include a usable sender id'
    );
    return { ok: true, action: 'ignored', reason: 'sender not detected' };
  }

  const seed = normalizeInboundSeed(payload, remoteJid);
  if (!seed) {
    return { ok: true, action: 'ignored', reason: 'empty message' };
  }
  const targetLabel = target?.label ?? seed.remoteJid;

  if (seedHasText(seed) && isTwilioSandboxDefaultEcho(seed.text ?? '')) {
    logger.info(
      { target: targetLabel, messageId: seed.id },
      'ignored twilio sandbox default echo'
    );
    return { ok: true, action: 'ignored', reason: 'twilio sandbox default echo' };
  }

  const state = loadRuntimeState();
  if (hasSeen(state, seed.remoteJid, seed.id)) {
    return { ok: true, action: 'ignored', reason: 'duplicate message' };
  }

  if (seedHasText(seed) && isRecentOutbound(state, seed.remoteJid, seed.text ?? '')) {
    markSeen(state, seed.remoteJid, [seed.id]);
    saveRuntimeState(state);
    logger.info(
      { target: targetLabel, messageId: seed.id },
      'ignored recent outbound echo'
    );
    return { ok: true, action: 'ignored', reason: 'recent outbound echo' };
  }

  markSeen(state, seed.remoteJid, [seed.id]);
  saveRuntimeState(state);

  const decision = decideMessageAction(seed.remoteJid, config.mode, config.policy);

  logger.info(
    {
      target: targetLabel,
      messageId: seed.id,
      action: decision.action,
      reasons: decision.reasons,
      profile: decision.profile,
      responderModel: config.responder.model,
      inputKind: isAudioSeed(seed) ? 'voice' : seed.media ? 'media' : 'text'
    },
    'openclaw inbound policy decision'
  );
  const decisionAt = Date.now();

  if (decision.action !== 'draft' && decision.action !== 'auto') {
    return { ok: true, action: decision.action, reasons: decision.reasons };
  }

  const seedGuidance = resolveGuidance(seed.remoteJid, config.policy);
  if (target && isLikelyImageMedia(seed.media) && seedGuidance.profile.tools.imageUnderstanding) {
    rememberImageReference(state, seed.remoteJid, {
      id: seed.id,
      path: seed.media?.path,
      url: seed.media?.url,
      type: seed.media?.type,
      fileName: seed.media?.fileName,
      caption: seed.text
    });
    saveRuntimeState(state);
    logger.info(
      {
        target: targetLabel,
        messageId: seed.id
      },
      'recorded inbound image reference before vision pass'
    );
  }

  const resolvedMessage = await resolveMessageFromSeed(seed, config);
  const normalizedAt = Date.now();
  if ('ignored' in resolvedMessage) {
    logger.info(
      { target: targetLabel, messageId: seed.id, reason: resolvedMessage.reason },
      'ignored inbound message after media normalization'
    );
    return { ok: true, action: 'ignored', reason: resolvedMessage.reason };
  }

  const message = resolvedMessage;
  const contextSettings = resolveConversationContext(message.remoteJid, config.policy);
  const conversationContext = getConversationContext(state, message.remoteJid, contextSettings);
  if (target && contextSettings.enabled) {
    rememberConversationEntry(state, message.remoteJid, 'inbound', message.text);
    saveRuntimeState(state);
  }
  const guidance = resolveGuidance(message.remoteJid, config.policy);
  if (target && guidance.profile.tools.imageUnderstanding && rememberInboundImageReference(state, message)) {
    saveRuntimeState(state);
  }
  const rememberAutoReply = (text: string): void => {
    rememberOutbound(state, message.remoteJid, text);
    if (target && contextSettings.enabled) {
      rememberConversationEntry(state, message.remoteJid, 'outbound', text);
    }
    saveRuntimeState(state);
  };
  const availableImageReferences = recentImageReferencesForPrompt(state, message, config);
  const plannerStartedAt = Date.now();
  const actionPlan = await generateActionPlan({
    remoteJid: message.remoteJid,
    text: message.text,
    policy: config.policy,
    responder: config.responder,
    conversationContext,
    imageReferences: availableImageReferences,
    canSendMedia: canSendOpenClawMedia(payload)
  });
  const plannerFinishedAt = Date.now();
  // The planner call broke (provider outage / out of credits / unparseable),
  // silently disabling weather/web_search/image tools. Log at error and tell the
  // draft to be honest instead of fabricating tool-grade data.
  const toolsUnavailable = actionPlan.status === 'failed';
  if (actionPlan.status === 'failed') {
    logger.error(
      {
        target: targetLabel,
        messageId: message.id,
        plannerReason: actionPlan.reason,
        plannerError: actionPlan.detail,
        raw: logReplyContent ? actionPlan.raw : undefined
      },
      'action planner failed; tools disabled for this message'
    );
  }

  const stickerAction = firstPlannedAction(actionPlan.actions, 'generate_sticker');
  const imageAction = stickerAction ? undefined : firstPlannedAction(actionPlan.actions, 'generate_image');
  const weatherAction = firstPlannedAction(actionPlan.actions, 'get_weather');
  const audioAction = firstPlannedAction(actionPlan.actions, 'reply_audio');
  const mediaAction = stickerAction ?? imageAction;
  const stickerRequest = Boolean(stickerAction);
  const imageRequest = Boolean(imageAction);
  const imageReferences = mediaAction?.useRecentImages ? availableImageReferences : [];
  // The planner already extracted a clean, geocodable location into the action
  // query; the resolver just geocodes it. Date words still come from the message.
  const weatherLocationQuery = weatherAction?.query?.trim() || undefined;
  const weatherStartedAt = Date.now();
  const weatherContext = weatherAction && guidance.profile.tools.weather
    ? await resolveWeatherPromptContext({
        text: message.text,
        locationQuery: weatherLocationQuery,
        metadata: message.raw.context?.metadata,
        weather: config.weather,
        force: true,
        logger
      })
    : undefined;
  const weatherFinishedAt = Date.now();

  const searchAction = firstPlannedAction(actionPlan.actions, 'web_search');
  const searchResult =
    searchAction && guidance.profile.tools.webSearch
      ? await resolveWebSearchPromptContext({
          query: searchAction.query ?? message.text,
          config: config.webSearch
        })
      : undefined;
  // 'empty' (searched, nothing useful) is logged + signaled like 'failed' so the
  // model is honest instead of answering from memory.
  if (searchResult && (searchResult.status === 'failed' || searchResult.status === 'empty')) {
    logger.warn(
      {
        target: targetLabel,
        messageId: message.id,
        webSearchStatus: searchResult.status,
        query: searchResult.query,
        reason: searchResult.status === 'failed' ? searchResult.reason : undefined
      },
      'web search failed; replying without current data'
    );
  }
  const webSearch =
    searchResult?.status === 'ok'
      ? ({ status: 'ok', prompt: searchResult.prompt } as const)
      : searchResult?.status === 'failed'
        ? ({ status: 'failed' } as const)
        : searchResult?.status === 'empty'
          ? ({ status: 'empty' } as const)
          : undefined;

  logger.info(
    {
      target: targetLabel,
      messageId: message.id,
      inputKind: message.inputKind,
      contextMessages: conversationContext.length,
      webSearchResults: searchResult?.status === 'ok' ? searchResult.resultCount : undefined,
      webSearchFailed: webSearch && webSearch.status !== 'ok' ? webSearch.status : undefined,
      textChars: message.text.length,
      plannerMs: plannerFinishedAt - plannerStartedAt,
      plannedActions: actionPlan.actions.map((action) => action.type),
      stickerRequest,
      imageRequest,
      imageReferenceCount: availableImageReferences.length,
      generationImageReferenceCount: imageReferences.length,
      imageUnderstandingProvider: message.inputKind === 'media' ? config.imageUnderstanding.provider : undefined,
      weatherLocationQuery,
      weatherStatus: weatherContext?.status,
      weatherConfidence: weatherContext?.confidence,
      weatherLocation: weatherContext?.locationLabel
    },
    'openclaw inbound message normalized'
  );

  if (stickerAction) {
    const stickerReply = guidance.profile.tools.stickerGeneration
      ? 'Pedido de figurinha detectado. Em modo auto, vou gerar e enviar a figurinha.'
      : guidance.profile.identityPolicy === 'open'
        ? 'Geracao de figurinha nao esta habilitada neste perfil.'
        : 'Nao consigo gerar figurinha daqui agora.';

    if (decision.action === 'draft') {
      logger.info(
        {
          target: targetLabel,
          messageId: message.id,
          reply: logReplyContent ? stickerReply : undefined,
          replyChars: stickerReply.length
        },
        'draft sticker request ready'
      );
      return { ok: true, action: 'draft', reply: stickerReply };
    }

    const delivery = decideDelivery(config.policy, target);
    if (!delivery.allowed) {
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reasons: delivery.reasons,
          reply: logReplyContent ? stickerReply : undefined,
          replyChars: stickerReply.length
        },
        'sticker auto reply blocked by delivery gate'
      );
      return { ok: true, action: 'blocked', reasons: delivery.reasons, reply: stickerReply };
    }

    const hourlyLimit = target?.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
    const recentAutoReplies = countRecentOutbound(state, message.remoteJid, 60 * 60 * 1000);
    if (recentAutoReplies >= hourlyLimit) {
      const reasons = [`max auto replies per hour reached (${hourlyLimit})`];
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reasons,
          reply: logReplyContent ? stickerReply : undefined,
          replyChars: stickerReply.length
        },
        'sticker auto reply blocked by rate limit'
      );
      return { ok: true, action: 'blocked', reasons, reply: stickerReply };
    }

    if (!guidance.profile.tools.stickerGeneration) {
      rememberAutoReply(stickerReply);
      return { ok: true, action: 'reply', reply: stickerReply };
    }

    if (!canSendOpenClawMedia(payload)) {
      const reply = 'Consigo entender o pedido de figurinha, mas este caminho de entrega ainda nao envia midia.';
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    const mediaStartedAt = Date.now();
    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        imageModel: config.imageGenerator.model,
        imageTimeoutMs: config.imageGenerator.timeoutMs,
        imageReferenceCount: imageReferences.length,
        stickerSize: config.sticker.size
      },
      'sticker generation started'
    );
    const generated = await generateImageFile({
      prompt: stickerPromptFromMessage(promptFromPlannedAction(stickerAction, message.text), imageReferences),
      config: config.imageGenerator,
      outputDir: config.media.outputDir,
      references: imageReferences,
      maxReferenceBytes: config.media.referenceMaxImageBytes
    });

    if (!generated.ok) {
      const mediaFinishedAt = Date.now();
      logger.info(
        {
          target: targetLabel,
          messageId: message.id,
          inputKind: message.inputKind,
          resolveMessageMs: normalizedAt - decisionAt,
          weatherMs: weatherFinishedAt - weatherStartedAt,
          mediaMs: mediaFinishedAt - mediaStartedAt,
          totalMs: mediaFinishedAt - handlerStartedAt
        },
        'openclaw inbound timings'
      );

      const reply = userVisibleMediaFailure(generated.reason, guidance.profile.identityPolicy, 'sticker');
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reason: generated.reason,
          reply: logReplyContent ? reply : undefined,
          replyChars: reply.length
        },
        'sticker image generation failed'
      );
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        imagePath: generated.media.path
      },
      'sticker source image generated'
    );

    const sticker = await convertImageToStickerFile({
      imagePath: generated.media.path,
      outputDir: config.media.outputDir,
      size: config.sticker.size,
      quality: config.sticker.quality,
      timeoutMs: config.sticker.timeoutMs
    });
    const mediaFinishedAt = Date.now();

    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        inputKind: message.inputKind,
        resolveMessageMs: normalizedAt - decisionAt,
        weatherMs: weatherFinishedAt - weatherStartedAt,
        mediaMs: mediaFinishedAt - mediaStartedAt,
        totalMs: mediaFinishedAt - handlerStartedAt
      },
      'openclaw inbound timings'
    );

    if (!sticker.ok) {
      const reply = userVisibleMediaFailure(sticker.reason, guidance.profile.identityPolicy, 'sticker');
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reason: sticker.reason,
          imagePath: generated.media.path,
          reply: logReplyContent ? reply : undefined,
          replyChars: reply.length
        },
        'sticker conversion failed'
      );
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        mediaPath: sticker.media.path
      },
      'sticker conversion finished'
    );

    try {
      await sendOpenClawStickerAsync(openClawTargetForMessage(message, target), {
        media: sticker.media.path
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const reply = userVisibleMediaFailure(reason, guidance.profile.identityPolicy, 'sticker');
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reason,
          reply: logReplyContent ? reply : undefined,
          replyChars: reply.length
        },
        'sticker media send failed'
      );
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    const memoryText = `[figurinha enviada] ${message.text}`;
    rememberAutoReply(memoryText);
    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        sourceImagePath: generated.media.path,
        mediaPath: sticker.media.path
      },
      'sticker media reply sent'
    );
    return { ok: true, action: 'sent_media', media: 'sticker' };
  }

  if (imageAction) {
    const imageReply = guidance.profile.tools.imageGeneration
      ? 'Pedido de imagem detectado. Em modo auto, vou gerar e enviar a imagem.'
      : guidance.profile.identityPolicy === 'open'
        ? 'Geracao de imagem nao esta habilitada neste perfil.'
        : 'Nao consigo gerar imagem daqui agora.';

    if (decision.action === 'draft') {
      logger.info(
        {
          target: targetLabel,
          messageId: message.id,
          reply: logReplyContent ? imageReply : undefined,
          replyChars: imageReply.length
        },
        'draft image request ready'
      );
      return { ok: true, action: 'draft', reply: imageReply };
    }

    const delivery = decideDelivery(config.policy, target);
    if (!delivery.allowed) {
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reasons: delivery.reasons,
          reply: logReplyContent ? imageReply : undefined,
          replyChars: imageReply.length
        },
        'image auto reply blocked by delivery gate'
      );
      return { ok: true, action: 'blocked', reasons: delivery.reasons, reply: imageReply };
    }

    const hourlyLimit = target?.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
    const recentAutoReplies = countRecentOutbound(state, message.remoteJid, 60 * 60 * 1000);
    if (recentAutoReplies >= hourlyLimit) {
      const reasons = [`max auto replies per hour reached (${hourlyLimit})`];
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reasons,
          reply: logReplyContent ? imageReply : undefined,
          replyChars: imageReply.length
        },
        'image auto reply blocked by rate limit'
      );
      return { ok: true, action: 'blocked', reasons, reply: imageReply };
    }

    if (!guidance.profile.tools.imageGeneration) {
      rememberAutoReply(imageReply);
      return { ok: true, action: 'reply', reply: imageReply };
    }

    if (!canSendOpenClawMedia(payload)) {
      const reply = 'Consigo entender o pedido de imagem, mas este caminho de entrega ainda nao envia midia.';
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    const mediaStartedAt = Date.now();
    const generated = await generateImageFile({
      prompt: imagePromptFromMessage(promptFromPlannedAction(imageAction, message.text), imageReferences),
      config: config.imageGenerator,
      outputDir: config.media.outputDir,
      references: imageReferences,
      maxReferenceBytes: config.media.referenceMaxImageBytes
    });
    const mediaFinishedAt = Date.now();

    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        inputKind: message.inputKind,
        resolveMessageMs: normalizedAt - decisionAt,
        weatherMs: weatherFinishedAt - weatherStartedAt,
        mediaMs: mediaFinishedAt - mediaStartedAt,
        totalMs: mediaFinishedAt - handlerStartedAt
      },
      'openclaw inbound timings'
    );

    if (!generated.ok) {
      const reply = userVisibleMediaFailure(generated.reason, guidance.profile.identityPolicy, 'image');
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reason: generated.reason,
          reply: logReplyContent ? reply : undefined,
          replyChars: reply.length
        },
        'image generation failed'
      );
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    try {
      await sendOpenClawMediaAsync(openClawTargetForMessage(message, target), {
        media: generated.media.path,
        message: 'Imagem gerada.'
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const reply = userVisibleMediaFailure(reason, guidance.profile.identityPolicy, 'image');
      logger.warn(
        {
          target: targetLabel,
          messageId: message.id,
          reason,
          reply: logReplyContent ? reply : undefined,
          replyChars: reply.length
        },
        'image media send failed'
      );
      rememberAutoReply(reply);
      return { ok: true, action: 'reply', reply };
    }

    const memoryText = `[imagem enviada] ${message.text}`;
    rememberAutoReply(memoryText);
    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        mediaPath: generated.media.path
      },
      'image media reply sent'
    );
    return { ok: true, action: 'sent_media', media: 'image' };
  }

  const responderStartedAt = Date.now();
  const reply = await generateDraftReply({
    remoteJid: message.remoteJid,
    text: message.text,
    policy: config.policy,
    responder: config.responder,
    conversationContext,
    weatherContext,
    webSearch,
    toolsUnavailable,
    imageReferences: availableImageReferences,
    logger
  });
  const responderFinishedAt = Date.now();

  logger.info(
    {
      target: targetLabel,
      messageId: message.id,
      inputKind: message.inputKind,
      resolveMessageMs: normalizedAt - decisionAt,
      weatherMs: weatherFinishedAt - weatherStartedAt,
      responderMs: responderFinishedAt - responderStartedAt,
      totalMs: responderFinishedAt - handlerStartedAt
    },
    'openclaw inbound timings'
  );

  if (decision.action === 'draft') {
    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'draft reply ready'
    );
    return { ok: true, action: 'draft', reply };
  }

  const delivery = decideDelivery(config.policy, target);
  if (!delivery.allowed) {
    logger.warn(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reasons: delivery.reasons,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'auto reply blocked by delivery gate'
    );
    return { ok: true, action: 'blocked', reasons: delivery.reasons, reply };
  }

  const hourlyLimit = target?.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
  const recentAutoReplies = countRecentOutbound(state, message.remoteJid, 60 * 60 * 1000);
  if (recentAutoReplies >= hourlyLimit) {
    const reasons = [`max auto replies per hour reached (${hourlyLimit})`];
    logger.warn(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reasons,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'auto reply blocked by rate limit'
    );
    return { ok: true, action: 'blocked', reasons, reply };
  }

  const audioRequested = Boolean(audioAction);
  const shouldReplyWithAudio =
    guidance.profile.voice.reply.enabled &&
    (guidance.profile.voice.reply.mode === 'always' ||
      (guidance.profile.voice.reply.mode === 'on_request' && audioRequested));
  let textReply = reply;
  const speechReply = audioAction?.text?.trim() || reply;

  if (shouldReplyWithAudio && canSendOpenClawMedia(payload)) {
    const speech = await synthesizeSpeechFile({
      text: speechReply.slice(0, guidance.profile.voice.reply.maxChars),
      config: config.speech,
      outputDir: config.media.outputDir
    });

    if (speech.ok) {
      try {
        await sendOpenClawMediaAsync(openClawTargetForMessage(message, target), {
          media: speech.media.path,
          message: guidance.profile.voice.reply.includeText ? reply : undefined
        });
        rememberAutoReply(reply);
        logger.info(
          {
            target: targetLabel,
            messageId: message.id,
            responderModel: config.responder.model,
            mediaPath: speech.media.path,
            includeText: guidance.profile.voice.reply.includeText,
            reply: logReplyContent ? reply : undefined,
            replyChars: reply.length
          },
          'audio media reply sent'
        );
        return {
          ok: true,
          action: 'sent_media',
          media: 'audio',
          reply: guidance.profile.voice.reply.includeText ? reply : undefined
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          { target: targetLabel, messageId: message.id, reason },
          'audio media send failed, falling back to text'
        );
        if (audioRequested) {
          textReply = `${userVisibleMediaFailure(reason, guidance.profile.identityPolicy, 'audio')}\n\n${reply}`;
        }
      }
    } else {
      logger.warn(
        { target: targetLabel, messageId: message.id, reason: speech.reason },
        'speech generation failed, falling back to text'
      );
      if (audioRequested) {
        textReply = `${userVisibleMediaFailure(speech.reason, guidance.profile.identityPolicy, 'audio')}\n\n${reply}`;
      }
    }
  } else if (shouldReplyWithAudio && audioRequested) {
    textReply = `${userVisibleMediaFailure('media delivery unavailable', guidance.profile.identityPolicy, 'audio')}\n\n${reply}`;
  }

  logger.info(
    {
      target: targetLabel,
      messageId: message.id,
      responderModel: config.responder.model,
      reply: logReplyContent ? textReply : undefined,
      replyChars: textReply.length
    },
    'auto reply approved'
  );
  rememberAutoReply(textReply);
  return { ok: true, action: 'reply', reply: textReply };
}

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = getRequestPath(request);

    if (request.method === 'GET' && requestPath === '/healthz') {
      try {
        const config = loadConfig();
        sendJson(response, 200, {
          ok: true,
          mode: config.mode,
          configOk: true,
          twilioOnly,
          twilioWebhookPath,
          responderModel: config.responder.model,
          responderBaseUrl: config.responder.baseUrl,
          weatherEnabled: config.weather.enabled,
          weatherProvider: config.weather.provider,
          imageGeneratorConfigured: Boolean(config.imageGenerator.apiKey),
          imageUnderstandingProvider: config.imageUnderstanding.provider,
          imageUnderstandingConfigured:
            config.imageUnderstanding.provider === 'codex-cli' ||
            config.imageUnderstanding.provider === 'custom' ||
            Boolean(config.imageUnderstanding.apiKey),
          speechConfigured: Boolean(config.speech.apiKey),
          transcriberModel: config.transcriber.model,
          transcriberConfigured: Boolean(config.transcriber.apiKey)
        });
      } catch (error) {
        sendJson(response, 200, {
          ok: true,
          configOk: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (request.method === 'POST' && requestPath === '/openclaw/message') {
      if (twilioOnly) {
        sendJson(response, 404, { ok: false, error: 'not-found' });
        return;
      }

      const payload = (await readJson(request)) as InboundPayload;
      sendJson(response, 200, await enqueueInboundByTarget(payload));
      return;
    }

    if (request.method === 'POST' && requestPath === '/openclaw/typing-policy') {
      if (twilioOnly) {
        sendJson(response, 404, { ok: false, error: 'not-found' });
        return;
      }

      const payload = (await readJson(request)) as InboundPayload;
      sendJson(response, 200, resolveTypingPolicyForInbound(payload));
      return;
    }

    if (request.method === 'POST' && requestPath === twilioWebhookPath) {
      const form = await readForm(request);
      if (validateTwilioSignature && !isValidTwilioSignature(request, form)) {
        logger.warn({ path: twilioWebhookPath }, 'twilio signature validation failed');
        sendXml(response, 403, buildTwilioResponse());
        return;
      }

      const result = await handleInbound(twilioFormToInboundPayload(form));
      const reply = replyFromResult(result);
      logger.info(
        {
          action: result && typeof result === 'object' && 'action' in result ? result.action : undefined,
          hasReply: Boolean(reply)
        },
        'twilio whatsapp webhook processed'
      );
      sendXml(response, 200, buildTwilioResponse(reply));
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'inbound handler failed');
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

registerWorkerProcess();
server.listen(port, host, () => {
  logger.info(
    {
      url: `http://${host}:${port}`,
      twilioWebhookPath,
      twilioOnly,
      validateTwilioSignature,
      mode: startupConfig.mode,
      targets: startupConfig.policy.targets.map((target) => ({
        label: target.label,
        id: target.id,
        mode: target.mode,
        enabled: target.enabled
      }))
    },
    'WhatsApp inbound bridge listening'
  );
  startRetroactiveReplyScanner();
});
