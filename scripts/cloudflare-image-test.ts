import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

// Standalone harness to try Cloudflare Workers AI text-to-image models before
// wiring one into the project. It does NOT touch the bot; it just calls the
// Workers AI REST API and saves the resulting images so you can compare.
//
// Usage:
//   npx tsx scripts/cloudflare-image-test.ts --list
//   npx tsx scripts/cloudflare-image-test.ts "um gato astronauta realista" [model ...]
//
// First positional arg is the prompt; any following args are model ids (e.g.
// @cf/black-forest-labs/flux-1-schnell). With no model ids a default candidate
// set is tried. Output goes to data/generated-media/cloudflare-test/.

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
const outputDir = path.resolve('data', 'generated-media', 'cloudflare-test');

// Flux returns JSON with a base64 image; SDXL-family returns raw image bytes.
// Unavailable ids simply report an error and are skipped.
const DEFAULT_MODELS = [
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/bytedance/stable-diffusion-xl-lightning'
];

function ensureCreds(): void {
  const missing =
    !accountId ||
    accountId.startsWith('PUT-YOUR') ||
    !apiToken ||
    apiToken.startsWith('PUT-YOUR');
  if (missing) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env first.');
    process.exit(1);
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${apiToken}` };
}

function sanitizeModelForFile(model: string): string {
  return model.replace(/^@cf\//, '').replace(/[^a-z0-9.-]+/gi, '_');
}

function isFlux(model: string): boolean {
  return /flux/i.test(model);
}

async function listModels(): Promise<void> {
  ensureCreds();
  const response = await fetch(
    `${API_BASE}/${accountId}/ai/models/search?task=Text-to-Image&per_page=100`,
    { headers: authHeaders() }
  );
  if (!response.ok) {
    console.error(`list failed (${response.status}): ${(await response.text()).slice(0, 600)}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    result?: Array<{ name?: string; task?: { name?: string }; description?: string }>;
  };
  const models = (data.result ?? []).filter((model) => /text-to-image/i.test(model.task?.name ?? ''));
  console.log(`Found ${models.length} Text-to-Image models:\n`);
  for (const model of models) {
    console.log(`  ${model.name}`);
    if (model.description) {
      console.log(`    ${model.description.slice(0, 120)}`);
    }
  }
  console.log('\nTip: pass any of these ids after the prompt to generate a test image.');
}

type GenResult = { model: string; ok: boolean; detail: string };

function bodyForModel(model: string, prompt: string): Record<string, unknown> {
  if (isFlux(model)) {
    // Flux only takes prompt/steps/seed; width/height would be rejected.
    return { prompt, steps: 6 };
  }
  return { prompt, width: 1024, height: 1024 };
}

async function generateFor(model: string, prompt: string): Promise<GenResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${API_BASE}/${accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(bodyForModel(model, prompt))
    });

    if (!response.ok) {
      throw new Error(`${response.status}: ${(await response.text()).slice(0, 600)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    let buffer: Buffer;
    let ext = 'png';

    if (contentType.includes('application/json')) {
      // Flux: { result: { image: "<base64 jpeg>" }, success, errors }
      const data = (await response.json()) as {
        success?: boolean;
        errors?: unknown;
        result?: { image?: string };
      };
      if (data.success === false || !data.result?.image) {
        throw new Error(`no image in JSON response: ${JSON.stringify(data).slice(0, 400)}`);
      }
      buffer = Buffer.from(data.result.image, 'base64');
      ext = 'jpg';
    } else {
      // SDXL-family: raw image bytes.
      buffer = Buffer.from(await response.arrayBuffer());
      ext = contentType.includes('png') ? 'png' : 'jpg';
    }

    const file = path.join(outputDir, `${sanitizeModelForFile(model)}.${ext}`);
    await fs.writeFile(file, buffer);
    const ms = Date.now() - startedAt;
    return { model, ok: true, detail: `${(buffer.byteLength / 1024).toFixed(0)} KB in ${ms}ms -> ${file}` };
  } catch (error) {
    return { model, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    await listModels();
    return;
  }

  ensureCreds();
  const prompt = args[0]?.trim() || 'paisagem natural deslumbrante, montanhas, lago cristalino, fotorrealista, luz dourada';
  const models = args.slice(1).length ? args.slice(1) : DEFAULT_MODELS;

  await fs.mkdir(outputDir, { recursive: true });
  console.log(`Prompt: ${prompt}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Output: ${outputDir}\n`);

  const results: GenResult[] = [];
  for (const model of models) {
    process.stdout.write(`- ${model} ... `);
    const result = await generateFor(model, prompt);
    results.push(result);
    console.log(result.ok ? `OK  ${result.detail}` : `FAIL ${result.detail}`);
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} succeeded. Open the files above to compare.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
