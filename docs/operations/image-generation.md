# Image Generation

The worker generates images (and the base image for stickers) through
`generateImageFile` in `src/media-tools.ts`. Two providers are supported, chosen
by `IMAGE_GENERATOR_PROVIDER`:

- `openai` — an OpenAI-compatible `/images/generations` (and `/images/edits`)
  endpoint. Used directly against OpenAI (`gpt-image-1`) or routed through
  codex-proxy in `codex-cli` media mode.
- `cloudflare` — Cloudflare Workers AI. Chosen by default when
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set.

The `claude` CLI cannot generate images, so on the claude backend Cloudflare
Workers AI is the image provider.

## Cloudflare Workers AI

Free tier is generous (~10k Neurons/day). The REST API is not OpenAI-compatible:

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
Authorization: Bearer {API_TOKEN}
```

Flux models return JSON with a base64 image (`result.image`); SDXL-family models
return raw image bytes. `generateCloudflareImageFile` branches on the response
content type, so both work.

### Credentials

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard -> Workers & Pages -> Account ID.
- `CLOUDFLARE_API_TOKEN`: My Profile -> API Tokens -> Create Token -> "Workers AI"
  template (`Account > Workers AI > Read`). Treat it like a password; it only
  lives in `.env` (gitignored).

### Config

```text
IMAGE_GENERATOR_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
IMAGE_GENERATOR_CLOUDFLARE_MODEL=@cf/black-forest-labs/flux-1-schnell
```

`IMAGE_GENERATOR_CLOUDFLARE_MODEL` is intentionally separate from
`IMAGE_GENERATOR_MODEL` (the OpenAI/codex id) so the two never collide.

### Choosing a model

`flux-1-schnell` is the default: fastest (~1-2s) and the fewest Neurons per
image, with photorealistic quality. Use the harness to compare alternatives:

```bash
npm run cf:list                                   # text-to-image models on your account
npm run cf:image "a sunset over the beach"        # default candidate set
npm run cf:image "a sunset" @cf/leonardo/lucid-origin
```

Output goes to `data/generated-media/cloudflare-test/` (gitignored). Notes:

- `flux-1-schnell` — fastest, cheapest, photorealistic. Recommended default.
- `@cf/leonardo/lucid-origin` — most striking quality, slower (~5s).
- FLUX.2 (`flux-2-klein-*`) models need a multipart request and are not wired in
  the harness/provider yet.

## Reference images

Cloudflare text-to-image models do not accept reference image bytes here. The
textual reference context (caption + image-understanding output) is already
folded into the prompt by the caller, so generation still uses it; the raw
reference bytes are only sent on the `openai` provider's `/images/edits` path.

## Failure handling

Media failures never leak internal provider output to the WhatsApp recipient.
`userVisibleMediaFailure` in `src/index.ts` summarizes the reason to a short,
URL-stripped first line even for `open` identity profiles.
