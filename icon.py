"""
Command Deck app icon.

The mark is the board itself: three stacked cards, each tagged with its
bucket's colour — teal for Now, amber for Waiting, indigo for Later.
Reads as a task board at full size and still resolves into three distinct
bars at 40px on a home screen.

Rendered at 4x and downsampled so every edge is properly antialiased.
"""
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 4                      # supersample factor
W = S * SS

BG_TOP = (0x1C, 0x22, 0x2C)
BG_BOTTOM = (0x0C, 0x0F, 0x13)
CARD = (0x2B, 0x33, 0x41)
CARD_EDGE = (0x3B, 0x45, 0x57)
LINE = (0x50, 0x5B, 0x6D)
DOTS = [
    (0x5E, 0xE6, 0xC5),     # now
    (0xF0, 0xB4, 0x5E),     # waiting
    (0x7C, 0x89, 0xF0),     # later
]

px = lambda v: int(v * SS)


def build():
    # --- background: vertical gradient with one soft teal bloom top-left ---
    base = Image.new("RGB", (W, W), BG_BOTTOM)
    d = ImageDraw.Draw(base)
    for y in range(W):
        t = y / (W - 1)
        d.line([(0, y), (W, y)], fill=tuple(
            round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        ))

    glow = Image.new("RGB", (W, W), (0, 0, 0))
    r = int(W * 0.40)
    ImageDraw.Draw(glow).ellipse(
        [int(W * 0.10) - r, int(W * 0.14) - r, int(W * 0.10) + r, int(W * 0.14) + r],
        fill=(0x14, 0x52, 0x45),
    )
    # screen-blend the glow so it lifts the background without a hard edge
    img = Image.blend(base, glow.filter(ImageFilter.GaussianBlur(W * 0.11)), 0.30)
    d = ImageDraw.Draw(img)

    # --- three cards ---
    card_h = px(196)
    gap = px(52)
    left = px(146)
    right = W - left
    top = (W - (card_h * 3 + gap * 2)) // 2
    radius = px(44)
    edge = px(3)

    for i, dot in enumerate(DOTS):
        y0 = top + i * (card_h + gap)
        y1 = y0 + card_h
        cy = (y0 + y1) // 2

        # Lighter outer rect, fill inset by its width — puts the border on
        # the rounded corners instead of floating above them.
        d.rounded_rectangle([left, y0, right, y1], radius, fill=CARD_EDGE)
        d.rounded_rectangle(
            [left + edge, y0 + edge, right - edge, y1 - edge],
            radius - edge,
            fill=CARD,
        )

        # Bucket dot.
        dr = px(34)
        dx = left + px(74)
        d.ellipse([dx - dr, cy - dr, dx + dr, cy + dr], fill=dot)

        # Content line — shorter each row so the stack has rhythm.
        lx0 = dx + px(64)
        lx1 = right - px(64) - px(i * 62)
        lh = px(13)
        d.rounded_rectangle([lx0, cy - lh, lx1, cy + lh], lh, fill=LINE)

    return img.resize((S, S), Image.LANCZOS)


if __name__ == "__main__":
    icon = build()
    icon.save("/home/claude/appicon-1024.png", "PNG")
    for size in (16, 32, 180, 192, 512):
        icon.resize((size, size), Image.LANCZOS).save(f"/home/claude/icon-{size}.png", "PNG")
    print("wrote appicon-1024.png and 16/32/180/192/512 variants")
