import type { BotPolicy, GuidanceProfile, TargetConfig } from './config.js';

export type ResolvedGuidance = {
  remoteJid: string;
  target?: TargetConfig;
  profileName: string;
  profile: GuidanceProfile;
};

export type ResolvedConversationContext = {
  enabled: boolean;
  maxMessages: number;
  maxAgeMinutes: number;
  includeOwnReplies: boolean;
};

const fallbackProfile: GuidanceProfile = {
  label: 'Default',
  language: 'pt-BR',
  tone: 'natural, breve e direto',
  identityPolicy: 'masked',
  retroactiveReply: {
    enabled: false,
    maxAgeHours: 12
  },
  typing: {
    enabled: true,
    intervalMs: 7000
  },
  tools: {
    webSearch: false,
    localRead: false,
    weather: false,
    imageUnderstanding: false,
    imageGeneration: false,
    stickerGeneration: false
  },
  voice: {
    enabled: false,
    transcribe: true,
    language: undefined,
    maxAudioBytes: 25 * 1024 * 1024,
    reply: {
      enabled: false,
      mode: 'on_request',
      includeText: false,
      maxChars: 1000
    }
  },
  instructions: ['Responda como assistente pessoal, sem parecer atendimento comercial.'],
  boundaries: ['Nao assuma compromissos, pagamentos ou decisoes sensiveis sem revisao humana.'],
  maxResponseChars: 700
};

export function findTargetConfig(remoteJid: string, policy: BotPolicy): TargetConfig | undefined {
  return policy.targets.find((target) => target.id === remoteJid);
}

export function resolveGuidance(remoteJid: string, policy: BotPolicy): ResolvedGuidance {
  const target = findTargetConfig(remoteJid, policy);
  const profileName = target?.profile ?? policy.defaults.profile;
  const profile = policy.profiles[profileName] ?? policy.profiles.default ?? fallbackProfile;

  return {
    remoteJid,
    target,
    profileName,
    profile
  };
}

export function resolveConversationContext(
  remoteJid: string,
  policy: BotPolicy
): ResolvedConversationContext {
  const target = findTargetConfig(remoteJid, policy);
  return {
    ...policy.conversationContext,
    ...(target?.context ?? {})
  };
}

export function buildGuidancePrompt(
  remoteJid: string,
  text: string,
  policy: BotPolicy,
  conversationContext: Array<{ role: 'inbound' | 'outbound'; text: string }> = [],
  structuredContext: { weather?: string; imageReferences?: string; webSearch?: string } = {}
): string {
  const guidance = resolveGuidance(remoteJid, policy);
  const label = guidance.target?.label ?? remoteJid;
  const profile = guidance.profile;
  const instructions = profile.instructions.length > 0 ? profile.instructions : fallbackProfile.instructions;
  const boundaries = profile.boundaries.length > 0 ? profile.boundaries : fallbackProfile.boundaries;
  const history = conversationContext.length
    ? [
        'Historico recente da conversa, do mais antigo para o mais novo:',
        ...conversationContext.map((item) => {
          const speaker = item.role === 'outbound' ? 'Voce' : label;
          return `- ${speaker}: ${item.text}`;
        }),
        'Use esse historico apenas como contexto local desta conversa. Nao mencione que recebeu historico.'
      ].join('\n')
    : 'Historico recente: [indisponivel ou desabilitado]';

  return [
    `Contato: ${label}`,
    `Idioma: ${profile.language}`,
    `Tom: ${profile.tone}`,
    `Politica de identidade: ${profile.identityPolicy}`,
    `Ferramentas permitidas: webSearch=${profile.tools.webSearch}, localRead=${profile.tools.localRead}, weather=${profile.tools.weather}, imageUnderstanding=${profile.tools.imageUnderstanding}, imageGeneration=${profile.tools.imageGeneration}, stickerGeneration=${profile.tools.stickerGeneration}`,
    `Audio permitido: voice=${profile.voice.enabled}, transcribe=${profile.voice.transcribe}, language=${profile.voice.language ?? 'auto'}, replyAudio=${profile.voice.reply.enabled ? profile.voice.reply.mode : 'off'}`,
    structuredContext.weather
      ? `Contexto meteorologico estruturado:\n${structuredContext.weather}`
      : 'Contexto meteorologico estruturado: [nenhum]',
    structuredContext.imageReferences
      ? `Contexto de imagens recentes nesta conversa:\n${structuredContext.imageReferences}`
      : 'Contexto de imagens recentes nesta conversa: [nenhum]',
    structuredContext.webSearch
      ? `Resultados de busca na web (use como fonte para informacao atual; cite a origem de forma natural; nao invente):\n${structuredContext.webSearch}`
      : 'Resultados de busca na web: [nenhum]',
    history,
    `Mensagem: ${text || '[sem texto extraivel]'}`,
    `Instrucoes: ${instructions.join(' ')}`,
    `Limites: ${boundaries.join(' ')}`,
    `Saida: escreva somente a mensagem final, com no maximo ${profile.maxResponseChars} caracteres.`
  ].join('\n');
}
