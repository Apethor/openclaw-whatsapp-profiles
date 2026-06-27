import type { Logger } from 'pino';
import type { AppConfig, TargetConfig } from './config.js';
import { decideDelivery } from './delivery-gate.js';
import { resolveConversationContext, resolveGuidance } from './guidance.js';
import {
  readOpenClawMessagesAsync,
  sendOpenClawMessageAsync,
  toOpenClawTarget,
  type OpenClawMessage
} from './openclaw-cli.js';
import { decideMessageAction } from './policy.js';
import { generateDraftReply } from './responder.js';
import {
  countRecentOutbound,
  hasSeen,
  loadRuntimeState,
  markSeen,
  rememberConversationEntry,
  rememberOutbound,
  saveRuntimeState,
  type ConversationEntry
} from './runtime-state.js';
import { resolveWeatherPromptContext } from './weather.js';

type RetroactiveLogger = Pick<Logger, 'debug' | 'info' | 'warn'>;

type TimedMessage = {
  message: OpenClawMessage;
  index: number;
  timeMs: number;
};

type PendingThread = {
  candidate: TimedMessage;
  pendingInbound: TimedMessage[];
};

let openClawWhatsAppReadUnsupported = false;

function isUnsupportedWhatsAppReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Message action read not supported for channel whatsapp');
}

function parseMessageTimeMs(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function orderedTimedMessages(messages: OpenClawMessage[], nowMs: number): TimedMessage[] {
  const futureSlackMs = 5 * 60 * 1000;
  return messages
    .map((message, index) => ({
      message,
      index,
      timeMs: parseMessageTimeMs(message.timestamp)
    }))
    .filter((item): item is TimedMessage => item.timeMs !== undefined && item.timeMs <= nowMs + futureSlackMs)
    .sort((left, right) => left.timeMs - right.timeMs || left.index - right.index);
}

function findPendingThread(messages: TimedMessage[], cutoffMs: number): PendingThread | undefined {
  const recent = messages.filter((item) => item.timeMs >= cutoffMs);
  if (recent.length === 0) {
    return undefined;
  }

  const lastOutboundIndex = recent.reduce(
    (latest, item, index) => (item.message.fromMe ? index : latest),
    -1
  );
  const pendingInbound = recent.slice(lastOutboundIndex + 1).filter((item) => !item.message.fromMe);
  const candidate = pendingInbound.at(-1);

  return candidate ? { candidate, pendingInbound } : undefined;
}

function historyContext(
  messages: TimedMessage[],
  candidate: TimedMessage,
  opts: {
    enabled: boolean;
    maxMessages: number;
    maxAgeMinutes: number;
    includeOwnReplies: boolean;
  }
): ConversationEntry[] {
  if (!opts.enabled || opts.maxMessages <= 0) {
    return [];
  }

  const cutoffMs = candidate.timeMs - opts.maxAgeMinutes * 60 * 1000;
  return messages
    .filter((item) => item.timeMs >= cutoffMs)
    .filter((item) => item.timeMs < candidate.timeMs || (item.timeMs === candidate.timeMs && item.index < candidate.index))
    .filter((item) => opts.includeOwnReplies || !item.message.fromMe)
    .slice(-opts.maxMessages)
    .map((item) => ({
      role: item.message.fromMe ? 'outbound' : 'inbound',
      text: item.message.text,
      createdAt: item.timeMs
    }));
}

function targetRetroactiveSettings(
  config: AppConfig,
  target: TargetConfig
): { enabled: boolean; maxAgeHours: number } {
  const guidance = resolveGuidance(target.id, config.policy);
  const profileSettings = guidance.profile.retroactiveReply;
  const targetSettings = target.retroactiveReply;

  return {
    enabled:
      target.enabled &&
      ((targetSettings.enabled ?? profileSettings.enabled) || config.openclaw.processExistingMessages),
    maxAgeHours: targetSettings.maxAgeHours ?? profileSettings.maxAgeHours
  };
}

export function hasRetroactiveReplyTargets(config: AppConfig): boolean {
  if (openClawWhatsAppReadUnsupported) {
    return false;
  }

  return config.policy.targets.some((target) => targetRetroactiveSettings(config, target).enabled);
}

async function processRetroactiveTarget(
  config: AppConfig,
  target: TargetConfig,
  logger: RetroactiveLogger
): Promise<void> {
  const settings = targetRetroactiveSettings(config, target);
  if (!settings.enabled) {
    return;
  }

  const guidance = resolveGuidance(target.id, config.policy);
  const targetLabel = target.label ?? target.id;
  const decision = decideMessageAction(target.id, config.mode, config.policy);
  if (decision.action !== 'auto') {
    logger.debug(
      { target: targetLabel, action: decision.action, reasons: decision.reasons, profile: guidance.profileName },
      'retroactive reply skipped by policy'
    );
    return;
  }

  const delivery = decideDelivery(config.policy, target);
  if (!delivery.allowed) {
    logger.debug(
      { target: targetLabel, reasons: delivery.reasons, profile: guidance.profileName },
      'retroactive reply skipped by delivery gate'
    );
    return;
  }

  const openclawTarget = toOpenClawTarget(target.id, target.openclawTarget);
  const messages = orderedTimedMessages(await readOpenClawMessagesAsync(openclawTarget, config.openclaw.readLimit), Date.now());
  const cutoffMs = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;
  const thread = findPendingThread(messages, cutoffMs);
  if (!thread) {
    return;
  }

  const state = loadRuntimeState();
  if (hasSeen(state, target.id, thread.candidate.message.id)) {
    return;
  }

  const hourlyLimit = target.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
  const recentAutoReplies = countRecentOutbound(state, target.id, 60 * 60 * 1000);
  if (recentAutoReplies >= hourlyLimit) {
    logger.warn(
      { target: targetLabel, messageId: thread.candidate.message.id, hourlyLimit },
      'retroactive reply blocked by rate limit'
    );
    return;
  }

  const contextSettings = resolveConversationContext(target.id, config.policy);
  const conversationContext = historyContext(messages, thread.candidate, contextSettings);
  // No planner in the retroactive path, so hand the raw message as the location
  // query; the resolver cleans + geocodes it.
  const weatherContext = guidance.profile.tools.weather
    ? await resolveWeatherPromptContext({
        text: thread.candidate.message.text,
        locationQuery: thread.candidate.message.text,
        metadata: undefined,
        weather: config.weather,
        now: new Date(thread.candidate.timeMs)
      })
    : undefined;
  const reply = await generateDraftReply({
    remoteJid: target.id,
    text: thread.candidate.message.text,
    policy: config.policy,
    responder: config.responder,
    conversationContext,
    weatherContext
  });

  const latestState = loadRuntimeState();
  if (hasSeen(latestState, target.id, thread.candidate.message.id)) {
    logger.debug(
      { target: targetLabel, messageId: thread.candidate.message.id },
      'retroactive reply skipped because live handler processed it'
    );
    return;
  }

  const latestRecentAutoReplies = countRecentOutbound(latestState, target.id, 60 * 60 * 1000);
  if (latestRecentAutoReplies >= hourlyLimit) {
    logger.warn(
      { target: targetLabel, messageId: thread.candidate.message.id, hourlyLimit },
      'retroactive reply blocked by rate limit after draft'
    );
    return;
  }

  await sendOpenClawMessageAsync(openclawTarget, reply);
  markSeen(
    latestState,
    target.id,
    thread.pendingInbound.map((item) => item.message.id)
  );
  if (contextSettings.enabled) {
    for (const item of thread.pendingInbound) {
      rememberConversationEntry(latestState, target.id, 'inbound', item.message.text);
    }
    rememberConversationEntry(latestState, target.id, 'outbound', reply);
  }
  rememberOutbound(latestState, target.id, reply);
  saveRuntimeState(latestState);

  logger.info(
    {
      target: targetLabel,
      messageId: thread.candidate.message.id,
      profile: guidance.profileName,
      ageHours: Number(((Date.now() - thread.candidate.timeMs) / (60 * 60 * 1000)).toFixed(2)),
      pendingInbound: thread.pendingInbound.length
    },
    'retroactive reply sent'
  );
}

export async function runRetroactiveReplyScan(config: AppConfig, logger: RetroactiveLogger): Promise<void> {
  if (openClawWhatsAppReadUnsupported) {
    return;
  }

  for (const target of config.policy.targets) {
    try {
      await processRetroactiveTarget(config, target, logger);
    } catch (error) {
      if (isUnsupportedWhatsAppReadError(error)) {
        openClawWhatsAppReadUnsupported = true;
        logger.warn(
          {
            target: target.label ?? target.id,
            error: error instanceof Error ? error.message : String(error)
          },
          'retroactive reply scan disabled because OpenClaw WhatsApp history read is unsupported'
        );
        return;
      }

      logger.warn(
        {
          target: target.label ?? target.id,
          error: error instanceof Error ? error.message : String(error)
        },
        'retroactive reply target scan failed'
      );
    }
  }
}
