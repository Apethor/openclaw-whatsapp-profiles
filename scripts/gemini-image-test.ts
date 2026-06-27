import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

// Standalone harness to try Google AI Studio (Gemini) image-generation models
// before wiring one into the project. It does NOT touch the bot; it just calls
// the Generative Language API and saves the resulting PNGs so you can compare.
//
// Usage:
//   npx tsx scripts/gemini-image-test.ts --list
//   npx tsx scripts/gemini-image-test.ts "um gato astronauta realista" [model ...]
//
// First positional arg is the prompt; any following args are model ids. With no
// model ids, a default candidate set is tried. Output goes to
// data/generated-media/gemini-test/.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
const outputDir = path.resolve('data', 'generated-media', 'gemini-test');

// Candidate image models to try when none are passed. Imagen models use the
// :predict endpoint; gemini-*-image* models use :generateContent with an image
// response modality. Unavailable ones simply report an error and are skipped.
const DEFAULT_MODELS = [
  'gemini-2.5-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-preview-image-generation',
  'imagen-4.0-generate-001',
  'imagen-4.0-fast-generate-001',
  'imagen-3.0-generate-002'
];

const ASPECT_RATIO = process.env.GEMINI_TEST_ASPECT ?? '1:1';

function ensureKey(): void {
  if (!apiKey || apiKey === 'PUT-YOUR-GOOGLE-AI-STUDIO-KEY-HERE') {
    console.error('GEMINI_API_KEY is not set. Put your Google AI Studio key in .env first.');
    process.exit(1);
  }
}

function extFromMime(mime: string | undefined): string {
  const normalized = (mime || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) {
    return 'jpg';
  }
  if (normalized.includes('webp')) {
    return 'webp';
  }
  return 'png';
}

function sanitizeModelForFile(model: string): string {
  return model.replace(/[^a-z0-9.-]+/gi, '_');
}

async function listModels(): Promise<void> {
  ensureKey();
  const response = await fetch(`${API_BASE}/models?key=${apiKey}&pageSize=200`);
  if (!response.ok) {
    console.error(`list failed (${response.status}): ${await response.text()}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  const models = data.models ?? [];
  const imageish = models.filter((model) => {
    const id = model.name ?? '';
    const methods = model.supportedGenerationMethods ?? [];
    return (
      methods.includes('predict') ||
      /image/i.test(id) ||
      /imagen/i.test(id)
    );
  });

  console.log(`Found ${models.length} models; likely image-capable:\n`);
  for (const model of imageish) {
    const id = (model.name ?? '').replace(/^models\//, '');
    console.log(`  ${id}`);
    console.log(`    methods: ${(model.supportedGenerationMethods ?? []).join(', ') || '(none listed)'}`);
  }
  console.log('\nTip: pass any of these ids after the prompt to generate a test image.');
}

type GenResult = { model: string; ok: boolean; detail: string };

async function generateImagen(model: string, prompt: string): Promise<{ base64: string; mime: string }> {
  const response = await fetch(`${API_BASE}/models/${model}:predict?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: ASPECT_RATIO }
    })
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 600)}`);
  }

  const data = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
  };
  const prediction = data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error(`no image in response: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { base64: prediction.bytesBase64Encoded, mime: prediction.mimeType ?? 'image/png' };
}

async function generateGemini(model: string, prompt: string): Promise<{ base64: string; mime: string }> {
  const response = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    })
  });

  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 600)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error(`no image in response: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { base64: imagePart.inlineData.data, mime: imagePart.inlineData.mimeType ?? 'image/png' };
}

async function generateFor(model: string, prompt: string): Promise<GenResult> {
  const isImagen = /imagen/i.test(model);
  const startedAt = Date.now();
  try {
    const result = isImagen ? await generateImagen(model, prompt) : await generateGemini(model, prompt);
    const buffer = Buffer.from(result.base64, 'base64');
    const file = path.join(outputDir, `${sanitizeModelForFile(model)}.${extFromMime(result.mime)}`);
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

  ensureKey();
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
