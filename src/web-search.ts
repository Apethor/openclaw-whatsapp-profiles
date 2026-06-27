import type { AppConfig } from './config.js';

export type WebSearchPromptContext = {
  // Formatted snippets injected into the responder prompt as the source of
  // truth for current/external info (Cloudflare chat models cannot browse, so
  // the worker searches and feeds results in).
  prompt: string;
  query: string;
  resultCount: number;
};

type TavilyResult = { title?: string; url?: string; content?: string };
type TavilyResponse = { answer?: string; results?: TavilyResult[] };

export async function resolveWebSearchPromptContext(input: {
  query: string;
  config: AppConfig['webSearch'];
}): Promise<WebSearchPromptContext | undefined> {
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
      console.warn(`[web-search] tavily failed (${response.status}) for query: ${query.slice(0, 80)}`);
      return undefined;
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
      return undefined;
    }

    return { prompt: lines.join('\n\n'), query, resultCount: results.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[web-search] tavily request error for query "${query.slice(0, 80)}": ${message}`);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
