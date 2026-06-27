import process from 'node:process';
import 'dotenv/config';

// Standalone harness for the Phase-2 web-search tool: Tavily search -> inject
// snippets into a Cloudflare text model -> grounded answer. This is exactly the
// flow the worker will run for profiles with tools.webSearch=true (CF chat
// models cannot browse, so the worker searches and feeds results in).
//
// Usage:
//   npx tsx scripts/tavily-search-test.ts "cotacao do dolar hoje"      # full loop
//   npx tsx scripts/tavily-search-test.ts --raw "noticias da bovespa"  # raw Tavily results only

const TAVILY_URL = 'https://api.tavily.com/search';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const tavilyKey = process.env.TAVILY_API_KEY?.trim() ?? '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
const chatModel = process.env.CF_CHAT_MODEL?.trim() || '@cf/meta/llama-4-scout-17b-16e-instruct';

const SYSTEM_PROMPT = [
  'Voce e um assistente pessoal respondendo no WhatsApp, em portugues brasileiro, natural, breve e direto.',
  'Voce recebe abaixo resultados de busca na web. Use-os como fonte para dar uma resposta atual e correta.',
  'Se os resultados nao responderem o pedido, diga que nao achou; nao invente.',
  'Nao diga que e IA, bot ou modelo. Nao explique seu raciocinio. Responda so o que foi pedido.'
].join(' ');

type TavilyResult = { title?: string; url?: string; content?: string; score?: number };
type TavilyResponse = {
  answer?: string;
  results?: TavilyResult[];
  response_time?: number;
  usage?: { credits?: number };
};

function ensureKeys(full: boolean): void {
  if (!tavilyKey || tavilyKey.startsWith('PUT-YOUR')) {
    console.error('Set TAVILY_API_KEY in .env first (get one at https://app.tavily.com).');
    process.exit(1);
  }
  if (full && (!accountId || !apiToken || accountId.startsWith('PUT-YOUR') || apiToken.startsWith('PUT-YOUR'))) {
    console.error('Full loop needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN too.');
    process.exit(1);
  }
}

async function tavilySearch(query: string): Promise<TavilyResponse> {
  const response = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${tavilyKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: 'advanced',
      topic: 'general'
    })
  });
  if (!response.ok) {
    throw new Error(`Tavily ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  return (await response.json()) as TavilyResponse;
}

function buildContext(results: TavilyResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title ?? ''}\n${(r.content ?? '').slice(0, 600)}\nfonte: ${r.url ?? ''}`)
    .join('\n\n');
}

async function answerWithContext(query: string, context: string): Promise<{ text: string; ms: number }> {
  const startedAt = Date.now();
  const response = await fetch(`${CF_API_BASE}/${accountId}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: chatModel,
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Pergunta: ${query}\n\nResultados de busca:\n${context}` }
      ]
    })
  });
  const ms = Date.now() - startedAt;
  if (!response.ok) {
    return { text: `CF ${response.status}: ${(await response.text()).slice(0, 300)}`, ms };
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { text: content || '(empty response)', ms };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const raw = args[0] === '--raw';
  const query = (raw ? args[1] : args[0])?.trim() || 'cotacao do dolar hoje';

  ensureKeys(!raw);
  console.log(`Query: ${query}\n`);

  const search = await tavilySearch(query);
  console.log(
    `Tavily: ${search.results?.length ?? 0} results, ${search.usage?.credits ?? '?'} credit(s), ${search.response_time ?? '?'}s`
  );
  for (const [i, r] of (search.results ?? []).entries()) {
    console.log(`  [${i + 1}] ${r.title ?? ''}\n      ${r.url ?? ''}`);
  }
  if (search.answer) {
    console.log(`\nTavily answer: ${search.answer}`);
  }

  if (raw) {
    return;
  }

  const { text, ms } = await answerWithContext(query, buildContext(search.results ?? []));
  console.log(`\n${'='.repeat(60)}\nGrounded answer (${chatModel}, ${ms}ms):\n${'='.repeat(60)}\n${text}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
