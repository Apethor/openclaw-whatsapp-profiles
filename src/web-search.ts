import type { AppConfig } from './config.js';

// 'ok' carries the snippets injected into the responder prompt as the source of
// truth for current/external info (Cloudflare chat models cannot browse).
// 'failed' is a distinct signal so the worker tells the model the search failed
// instead of letting it answer from stale memory. 'empty' = reached Tavily, no
// usable results. undefined = not attempted (disabled / no key / empty query).
export type WebSearchResult =
  | { status: 'ok'; prompt: string; query: string; resultCount: number }
  | { status: 'failed'; query: string; reason: string }
  | { status: 'empty'; query: string };

type TavilyResult = { title?: string; url?: string; content?: string };
type TavilyResponse = { answer?: string; results?: TavilyResult[] };

export async function resolveWebSearchPromptContext(input: {
  query: string;
  config: AppConfig['webSearch'];
}): Promise<WebSearchResult | undefined> {
  if (input.config.provider === 'off' || !input.config.apiKey) {
    return undefined;
  }

  const query = input.query.trim();
  if (!query) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.config.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        query,
        search_depth: input.config.searchDepth,
        max_results: input.config.maxResults,
        include_answer: 'advanced',
        topic: 'general'
      })
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      return { status: 'failed', query, reason: `tavily HTTP ${response.status}${body ? `: ${body}` : ''}` };
    }

    const data = (await response.json()) as TavilyResponse;
    const results = data.results ?? [];
    const lines: string[] = [];
    if (data.answer?.trim()) {
      lines.push(`Resumo da busca: ${data.answer.trim()}`);
    }
    results.forEach((result, index) => {
      lines.push(
        `[${index + 1}] ${result.title ?? ''}\n${(result.content ?? '').slice(0, 600)}\nfonte: ${result.url ?? ''}`
      );
    });

    if (!lines.length) {
      return { status: 'empty', query };
    }

    return { status: 'ok', prompt: lines.join('\n\n'), query, resultCount: results.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', query, reason: message };
  } finally {
    clearTimeout(timeout);
  }
}
