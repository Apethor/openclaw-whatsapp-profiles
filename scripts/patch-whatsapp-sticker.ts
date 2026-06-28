import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PatchResult = {
  changed: boolean;
  file: string;
};

function openclawHome(): string {
  return process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), '.openclaw');
}

function listDistFiles(distDir: string): string[] {
  return fs
    .readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(distDir, file));
}

function patchFileByPredicate(
  distFiles: string[],
  label: string,
  predicate: (content: string) => boolean,
  patch: (content: string) => string
): PatchResult {
  const file = distFiles.find((candidate) => predicate(fs.readFileSync(candidate, 'utf8')));
  if (!file) {
    throw new Error(`could not find WhatsApp plugin bundle for ${label}`);
  }

  const original = fs.readFileSync(file, 'utf8');
  const patched = patch(original);
  if (patched !== original) {
    fs.writeFileSync(file, patched);
  }

  return { changed: patched !== original, file };
}

function replaceRequired(content: string, before: string, after: string, label: string): string {
  if (content.includes(after)) {
    return content;
  }
  if (!content.includes(before)) {
    throw new Error(`could not patch ${label}: expected code was not found`);
  }
  return content.replace(before, after);
}

function patchSendApi(content: string): string {
  // Inject a sticker branch immediately ahead of the image branch. Newer OpenClaw
  // builds wrap the image payload in addWhatsAppImagePreviewFields(...); older ones
  // used a plain object literal. Match either so the patch survives plugin updates
  // that only reshape the image branch.
  if (content.includes('sticker: mediaBuffer')) {
    return content;
  }

  const stickerBranch = `else if (sendOptions?.asSticker === true && mediaType.startsWith("image/")) payload = {
\t\t\t\tsticker: mediaBuffer,
\t\t\t\tmimetype: mediaType
\t\t\t};
\t\t\t`;

  const imageBranchVariants = [
    `else if (mediaType.startsWith("image/")) payload = await addWhatsAppImagePreviewFields({
\t\t\t\timage: mediaBuffer,
\t\t\t\tcaption: resolvedPayloadText.text || void 0,
\t\t\t\tmimetype: mediaType
\t\t\t});`,
    `else if (mediaType.startsWith("image/")) payload = {
\t\t\t\timage: mediaBuffer,
\t\t\t\tcaption: resolvedPayloadText.text || void 0,
\t\t\t\tmimetype: mediaType
\t\t\t};`
  ];

  for (const imageBranch of imageBranchVariants) {
    if (content.includes(imageBranch)) {
      return content.replace(imageBranch, stickerBranch + imageBranch);
    }
  }

  throw new Error('could not patch send-api sticker payload: expected code was not found');
}

function patchSendOptions(content: string): string {
  let next = replaceRequired(
    content,
    'const sendOptions = options.gifPlayback || forceDocumentDelivery || accountId || documentFileName || options.quotedMessageKey ? {',
    'const sendOptions = options.gifPlayback || forceDocumentDelivery || options.asSticker || accountId || documentFileName || options.quotedMessageKey ? {',
    'send options sticker condition'
  );
  next = replaceRequired(
    next,
    `\t\t\t...forceDocumentDelivery ? { asDocument: true } : {},
\t\t\t...documentFileName ? { fileName: documentFileName } : {},`,
    `\t\t\t...forceDocumentDelivery ? { asDocument: true } : {},
\t\t\t...options.asSticker ? { asSticker: true } : {},
\t\t\t...documentFileName ? { fileName: documentFileName } : {},`,
    'send options sticker flag'
  );
  next = replaceRequired(
    next,
    'optimizeImages: options.forceDocument ? false : void 0,',
    'optimizeImages: options.forceDocument || options.asSticker ? false : void 0,',
    'send options sticker media optimization'
  );
  return next;
}

function patchUploadFileAction(content: string): string {
  const before = `\t\tgifPlayback: readBooleanParam(params.params, "gifPlayback") ?? void 0,
\t\taudioAsVoice: readBooleanParam(params.params, "asVoice") ?? readBooleanParam(params.params, "audioAsVoice") ?? void 0,
\t\tforceDocument: readBooleanParam(params.params, "forceDocument") ?? readBooleanParam(params.params, "asDocument") ?? void 0,`;
  const after = `\t\tgifPlayback: readBooleanParam(params.params, "gifPlayback") ?? void 0,
\t\taudioAsVoice: readBooleanParam(params.params, "asVoice") ?? readBooleanParam(params.params, "audioAsVoice") ?? void 0,
\t\tasSticker: readBooleanParam(params.params, "asSticker") ?? readBooleanParam(params.params, "sticker") ?? void 0,
\t\tforceDocument: readBooleanParam(params.params, "forceDocument") ?? readBooleanParam(params.params, "asDocument") ?? void 0,`;
  return replaceRequired(content, before, after, 'upload-file asSticker parameter');
}

function main(): void {
  const distDir = path.join(openclawHome(), 'extensions', 'whatsapp', 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw WhatsApp plugin dist directory not found: ${distDir}`);
  }

  const distFiles = listDistFiles(distDir);
  const results = [
    patchFileByPredicate(
      distFiles,
      'send api',
      (content) => content.includes('function createWebSendApi') && content.includes('mediaType.startsWith("image/")'),
      patchSendApi
    ),
    patchFileByPredicate(
      distFiles,
      'send options',
      (content) => content.includes('async function sendMessageWhatsApp') && content.includes('const sendOptions = options.gifPlayback'),
      patchSendOptions
    ),
    patchFileByPredicate(
      distFiles,
      'upload-file action',
      (content) => content.includes('function readUploadFileMediaSource') && content.includes('audioAsVoice:'),
      patchUploadFileAction
    )
  ];

  for (const result of results) {
    console.log(`${result.changed ? 'patched' : 'already patched'} ${path.relative(distDir, result.file)}`);
  }
}

main();
