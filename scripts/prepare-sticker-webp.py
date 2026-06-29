#!/usr/bin/env python3
import argparse
import sys
from statistics import median
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit(
        "Pillow is required for sticker WebP preparation. Run: npm run media:install"
    ) from exc


def detect_background_excess(px, width: int, height: int, frame: int) -> tuple[float, float]:
    """Sample the image border and report the median "green excess" (g - max(r, b))
    of clearly green pixels plus how much of the border is green. The generator is
    asked for a flat #00ff00 backdrop, but small models emit an inconsistent
    grass-green with a brightness gradient; measuring the actual border green lets
    the keyer adapt instead of trusting a fixed key color."""
    values = []
    for y in range(height):
        on_edge_row = y < frame or y >= height - frame
        for x in range(width):
            if not (on_edge_row or x < frame or x >= width - frame):
                continue
            r, g, b = px[x, y][:3]
            excess = g - max(r, b)
            if excess > 15:
                values.append(excess)
    border_total = 2 * frame * (width + height) - 4 * frame * frame
    coverage = len(values) / border_total if border_total else 0.0
    return (median(values) if values else 0.0), coverage


def remove_green_background(image: Image.Image, frame: int) -> bool:
    """Key out the green screen by relative green dominance (robust to the exact
    green tone and to brightness gradients) and despill the residual green fringe.
    Returns whether keying was applied."""
    px = image.load()
    width, height = image.size
    bg_excess, coverage = detect_background_excess(px, width, height, frame)

    # Only treat it as a green screen when the border is convincingly green, so a
    # normal image handed in by mistake is left fully intact.
    keying = coverage >= 0.5 and bg_excess >= 40
    if not keying:
        return False

    hi = max(60.0, bg_excess * 0.55)
    lo = max(15.0, bg_excess * 0.18)
    span = max(1.0, hi - lo)

    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            mx = max(r, b)
            excess = g - mx
            if excess >= hi:
                px[x, y] = (0, 0, 0, 0)
                continue
            alpha = a if excess <= lo else int(round(a * (hi - excess) / span))
            if g > mx:
                g = mx  # despill: pull the green fringe down to a neutral tone
            px[x, y] = (r, g, b, alpha)
    return True


def despill_green(image: Image.Image) -> None:
    """Clamp every green-dominant pixel down to a neutral tone (g -> max(r, b))."""
    px = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            mx = max(r, b)
            if g > mx:
                px[x, y] = (r, mx, b, a)


def fit_square(image: Image.Image, size: int) -> Image.Image:
    scale = min(size / image.width, size / image.height)
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(target, Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - target[0]) // 2, (size - target[1]) // 2))
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare a WhatsApp sticker WebP: chroma-key the green background and emit exact transparency."
    )
    parser.add_argument("input_image", type=Path)
    parser.add_argument("output_webp", type=Path)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=75)
    parser.add_argument("--method", type=int, default=6)
    parser.add_argument("--border-frame", type=int, default=6)
    args = parser.parse_args()

    image = Image.open(args.input_image).convert("RGBA")
    keyed = remove_green_background(image, max(1, args.border_frame))
    square = fit_square(image, max(64, min(1024, args.size)))
    if keyed:
        # LANCZOS resizes the RGBA channels independently, so its ringing can push
        # the green channel back above r/b at the antialiased edges and reintroduce
        # a faint green rim. Despill once more on the final canvas to remove it.
        despill_green(square)

    args.output_webp.parent.mkdir(parents=True, exist_ok=True)
    square.save(
        args.output_webp,
        "WEBP",
        lossless=True,
        quality=max(1, min(100, args.quality)),
        method=max(0, min(6, args.method)),
        exact=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
