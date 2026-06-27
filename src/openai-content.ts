export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

// OpenAI-compatible endpoints differ on message.content: a string for most, an
// array of parts for some, or an auto-parsed object on Cloudflare Workers AI.
// Flatten all shapes to text so callers never choke on the provider quirk.
//
// objectAsJson: ONLY the planner (which JSON.parses the text back) wants an
// auto-parsed object re-serialized. User-facing paths (draft reply, vision) must
// NOT — otherwise a raw JSON blob is sent verbatim to the user. They get '' and
// the caller treats it as an empty response.
export function extractMessageContent(
  message: { content?: unknown } | undefined,
  options?: { objectAsJson?: boolean }
): string {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        const text = (part as { text?: unknown })?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  if (content && typeof content === 'object' && options?.objectAsJson) {
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}
