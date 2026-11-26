"""Draws the Muster mark (the same shape as `Mark` in the web app) as the app icon and splash images."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
SCALE = 4  # draw large, then shrink, for smooth edges


def mark(size: int, square: str | None, glyph: tuple[int, int, int], radius: float = 9) -> Image.Image:
    """The mark on a 32-unit grid. `square` is the tile colour, or None for the glyph alone."""
    big = size * SCALE
    unit = big / 32
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if square:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius * unit, fill=square)

    def dot(cx: float, cy: float, r: float, alpha: int = 255) -> None:
        draw.ellipse(
            ((cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit),
            fill=(*glyph, alpha),
        )

    def bar(x: float, y: float, w: float, h: float, alpha: int = 255) -> None:
        layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            (x * unit, y * unit, (x + w) * unit, (y + h) * unit),
            radius=h / 2 * unit,
            fill=(*glyph, alpha),
        )
        image.alpha_composite(layer)

    dot(10, 11, 2.2)
    dot(10, 21, 2.2)
    bar(15, 9.4, 9, 3.2)
    bar(15, 19.4, 9, 3.2, alpha=140)
    return image.resize((size, size), Image.LANCZOS)


def icon() -> Image.Image:
    """App icons are full squares with no transparency: iOS rounds the corners itself."""
    canvas = Image.new("RGBA", (1024, 1024), "#000000")
    glyph = mark(1024, None, (255, 255, 255))
    canvas.alpha_composite(glyph)
    return canvas.convert("RGB")


OUT.mkdir(exist_ok=True)
icon().save(OUT / "icon.png")
mark(512, "#000000", (255, 255, 255)).save(OUT / "splash-mark.png")
mark(512, "#ffffff", (0, 0, 0)).save(OUT / "splash-mark-dark.png")
print("wrote", *(p.name for p in sorted(OUT.glob("*.png"))))
