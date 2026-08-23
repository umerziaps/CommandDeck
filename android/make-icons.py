"""
Generates the Android adaptive launcher icon from the same mark as the iOS
app and the web favicon.

Adaptive icons are 108dp square, but the launcher may mask anything outside
the centre 66dp — so the artwork is drawn at ~58% scale, centred, on a
transparent foreground. The background is a flat colour resource.

Run from the `android/` directory:  python3 make-icons.py
"""
from PIL import Image, ImageDraw

SS = 4  # supersample

CARD = (0x2B, 0x33, 0x41)
CARD_EDGE = (0x3B, 0x45, 0x57)
LINE = (0x50, 0x5B, 0x6D)
DOTS = [
    (0x5E, 0xE6, 0xC5),   # now
    (0xF0, 0xB4, 0x5E),   # waiting
    (0x7C, 0x89, 0xF0),   # later
]

# density bucket -> foreground size in px (108dp at that density)
DENSITIES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}


def foreground(size):
    W = size * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Artwork occupies the middle ~58% so the launcher's mask can't clip it.
    art = W * 0.58
    left = (W - art) / 2
    right = left + art

    card_h = art * 0.265
    gap = art * 0.10
    total = card_h * 3 + gap * 2
    top = (W - total) / 2
    radius = card_h * 0.30
    edge = max(1, int(card_h * 0.022))

    for i, dot in enumerate(DOTS):
        y0 = top + i * (card_h + gap)
        y1 = y0 + card_h
        cy = (y0 + y1) / 2

        d.rounded_rectangle([left, y0, right, y1], radius, fill=CARD_EDGE)
        d.rounded_rectangle(
            [left + edge, y0 + edge, right - edge, y1 - edge],
            radius - edge, fill=CARD,
        )

        dr = card_h * 0.30
        dx = left + art * 0.14
        d.ellipse([dx - dr, cy - dr, dx + dr, cy + dr], fill=dot)

        lx0 = dx + dr * 2.0
        lx1 = right - art * 0.09 - (i * art * 0.09)
        lh = card_h * 0.075
        d.rounded_rectangle([lx0, cy - lh, lx1, cy + lh], lh, fill=LINE)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import pathlib

    for bucket, size in DENSITIES.items():
        out = pathlib.Path(f"app/src/main/res/drawable-{bucket}")
        out.mkdir(parents=True, exist_ok=True)
        foreground(size).save(out / "ic_launcher_foreground.png", "PNG")
        print(f"wrote drawable-{bucket}/ic_launcher_foreground.png ({size}px)")
