import process from 'node:process';
import 'dotenv/config';

const host = process.env.CLAUDE_PROXY_HOST ?? '127.0.0.1';
const port = process.env.CLAUDE_PROXY_PORT ?? '8789';
const apiKey = process.env.CLAUDE_PROXY_API_KEY ?? 'dev-local-change-me';
const model = process.env.CLAUDE_PROXY_MODEL ?? 'sonnet';

const response = await fetch(`http://${host}:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly: pong'
      }
    ]
  })
});

const body = await response.text();
console.log(body);

if (!response.ok) {
  process.exitCode = 1;
}
