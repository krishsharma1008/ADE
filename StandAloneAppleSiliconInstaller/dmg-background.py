#!/usr/bin/env python3
"""
Combyne AI — DMG Background Generator
Creates a branded background image for the DMG installer window.

Layout:
  - Deep black (#0B0B0F) background with subtle honeycomb pattern
  - "Drag to Applications" arrow graphic in amber gold
  - Combyne AI branding

Output: 600x400 PNG
"""

import struct
import zlib
import math
import os
import sys

# ── Brand Colors ─────────────────────────────────────────────────────────────
BG = (11, 11, 15)            # #0B0B0F
GOLD = (245, 166, 35)        # #F5A623
DIM_GOLD = (120, 80, 20)     # Dim gold for hex grid
TEXT_WHITE = (220, 220, 225)  # Soft white for text
ARROW_GOLD = (234, 179, 8)   # #EAB308


def create_png(width, height, pixels):
    """Create a PNG from flat list of (r,g,b,a) tuples."""
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))

    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw += bytes([r, g, b, a])

    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend


def clamp(v):
    return max(0, min(255, int(v)))


def distance(x1, y1, x2, y2):
    return math.sqrt((x1 - x2)**2 + (y1 - y2)**2)


def hex_edge_distance(x, y, cx, cy, size):
    """Distance from point to nearest hexagon edge."""
    dx = abs(x - cx) / size
    dy = abs(y - cy) / size
    return max(dx * 2 / math.sqrt(3) + dy, dy * 2) - 1.0


def draw_arrow(pixels, w, h, x1, y1, x2, y2, color, thickness=3):
    """Draw an arrow from (x1,y1) to (x2,y2)."""
    # Draw line
    steps = int(distance(x1, y1, x2, y2) * 2)
    for i in range(steps):
        t = i / steps
        px = x1 + (x2 - x1) * t
        py = y1 + (y2 - y1) * t
        for dy in range(-thickness, thickness + 1):
            for dx in range(-thickness, thickness + 1):
                if dx*dx + dy*dy <= thickness*thickness:
                    ix, iy = int(px + dx), int(py + dy)
                    if 0 <= ix < w and 0 <= iy < h:
                        pixels[iy * w + ix] = (*color, 255)

    # Arrowhead
    angle = math.atan2(y2 - y1, x2 - x1)
    head_len = 18
    head_angle = 0.45
    for sign in [-1, 1]:
        a = angle + math.pi + sign * head_angle
        hx = x2 + head_len * math.cos(a)
        hy = y2 + head_len * math.sin(a)
        steps2 = int(head_len * 2)
        for i in range(steps2):
            t = i / steps2
            px = x2 + (hx - x2) * t
            py = y2 + (hy - y2) * t
            for dy in range(-thickness, thickness + 1):
                for dx in range(-thickness, thickness + 1):
                    if dx*dx + dy*dy <= thickness*thickness:
                        ix, iy = int(px + dx), int(py + dy)
                        if 0 <= ix < w and 0 <= iy < h:
                            pixels[iy * w + ix] = (*color, 255)


# ── Bitmap font for key text ────────────────────────────────────────────────
# Simplified 5x7 pixel font for uppercase + common chars
FONT = {
    'D': ["1111 ", "1   1", "1   1", "1   1", "1   1", "1   1", "1111 "],
    'R': ["1111 ", "1   1", "1   1", "1111 ", "1  1 ", "1   1", "1   1"],
    'A': [" 111 ", "1   1", "1   1", "11111", "1   1", "1   1", "1   1"],
    'G': [" 111 ", "1   1", "1    ", "1 111", "1   1", "1   1", " 111 "],
    'T': ["11111", "  1  ", "  1  ", "  1  ", "  1  ", "  1  ", "  1  "],
    'O': [" 111 ", "1   1", "1   1", "1   1", "1   1", "1   1", " 111 "],
    'P': ["1111 ", "1   1", "1   1", "1111 ", "1    ", "1    ", "1    "],
    'L': ["1    ", "1    ", "1    ", "1    ", "1    ", "1    ", "11111"],
    'I': ["11111", "  1  ", "  1  ", "  1  ", "  1  ", "  1  ", "11111"],
    'C': [" 111 ", "1   1", "1    ", "1    ", "1    ", "1   1", " 111 "],
    'N': ["1   1", "11  1", "1 1 1", "1  11", "1   1", "1   1", "1   1"],
    'S': [" 111 ", "1   1", "1    ", " 111 ", "    1", "1   1", " 111 "],
    'E': ["11111", "1    ", "1    ", "1111 ", "1    ", "1    ", "11111"],
    'B': ["1111 ", "1   1", "1   1", "1111 ", "1   1", "1   1", "1111 "],
    'Y': ["1   1", "1   1", " 1 1 ", "  1  ", "  1  ", "  1  ", "  1  "],
    'M': ["1   1", "11 11", "1 1 1", "1   1", "1   1", "1   1", "1   1"],
    'H': ["1   1", "1   1", "1   1", "11111", "1   1", "1   1", "1   1"],
    'V': ["1   1", "1   1", "1   1", "1   1", " 1 1 ", " 1 1 ", "  1  "],
    'W': ["1   1", "1   1", "1   1", "1 1 1", "1 1 1", "11 11", "1   1"],
    'F': ["11111", "1    ", "1    ", "1111 ", "1    ", "1    ", "1    "],
    'U': ["1   1", "1   1", "1   1", "1   1", "1   1", "1   1", " 111 "],
    '.': ["     ", "     ", "     ", "     ", "     ", "     ", "  1  "],
    ' ': ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
}


def draw_text(pixels, w, h, text, start_x, start_y, color, scale=2):
    """Draw text using the bitmap font."""
    cx = start_x
    for ch in text.upper():
        glyph = FONT.get(ch)
        if glyph is None:
            cx += 4 * scale
            continue
        for row_idx, row in enumerate(glyph):
            for col_idx, pixel in enumerate(row):
                if pixel == '1':
                    for sy in range(scale):
                        for sx in range(scale):
                            px = cx + col_idx * scale + sx
                            py = start_y + row_idx * scale + sy
                            if 0 <= px < w and 0 <= py < h:
                                pixels[py * w + px] = (*color, 255)
        cx += (len(glyph[0]) + 1) * scale


def text_width(text, scale=2):
    """Calculate pixel width of rendered text."""
    total = 0
    for ch in text.upper():
        glyph = FONT.get(ch)
        if glyph:
            total += (len(glyph[0]) + 1) * scale
        else:
            total += 4 * scale
    return total


def generate_background(width=600, height=400):
    """Generate DMG background image."""
    pixels = [(*BG, 255)] * (width * height)

    # Subtle honeycomb pattern
    hex_size = 30
    hex_centers = []
    for row in range(-2, height // int(hex_size * math.sqrt(3)) + 4):
        for col in range(-2, width // int(hex_size * 1.5) + 4):
            hx = col * hex_size * 1.75
            hy = row * hex_size * math.sqrt(3) + (hex_size * math.sqrt(3) * 0.5 if col % 2 else 0)
            hex_centers.append((hx, hy))

    for y in range(height):
        for x in range(width):
            min_edge = float('inf')
            for hx, hy in hex_centers:
                he = hex_edge_distance(x, y, hx, hy, hex_size)
                if abs(he) < abs(min_edge):
                    min_edge = he

            edge_dist = abs(min_edge * hex_size)
            if edge_dist < 1.5:
                intensity = (1.5 - edge_dist) / 1.5 * 0.08
                r = clamp(BG[0] + intensity * DIM_GOLD[0])
                g = clamp(BG[1] + intensity * DIM_GOLD[1])
                b = clamp(BG[2] + intensity * DIM_GOLD[2])
                pixels[y * width + x] = (r, g, b, 255)

    # ── "Drag to Applications" text (centered above the arrow) ───────────
    text = "DRAG TO APPLICATIONS"
    tw = text_width(text, scale=2)
    text_x = (width - tw) // 2
    text_y = 330
    draw_text(pixels, width, height, text, text_x, text_y, ARROW_GOLD, scale=2)

    # ── Arrow from app icon area to Applications area ────────────────────
    # App icon sits at roughly x=150, Applications symlink at x=450
    # Arrow goes from left zone to right zone, centered vertically at y=200
    arrow_y = 200
    draw_arrow(pixels, width, height, 215, arrow_y, 385, arrow_y, ARROW_GOLD, thickness=2)

    # ── Combyne AI branding at top ───────────────────────────────────────
    brand = "COMBYNE.AI"
    bw = text_width(brand, scale=2)
    draw_text(pixels, width, height, brand, (width - bw) // 2, 20, GOLD, scale=2)

    # Tagline
    tagline = "THE HIVE THAT GETS THINGS DONE"
    tw2 = text_width(tagline, scale=1)
    draw_text(pixels, width, height, tagline, (width - tw2) // 2, 42, DIM_GOLD, scale=1)

    # Subtle border glow at top and bottom
    for y in range(height):
        for x in range(width):
            # Top edge glow
            if y < 3:
                fade = (3 - y) / 3 * 0.15
                r, g, b, a = pixels[y * width + x]
                r = clamp(r + fade * GOLD[0])
                g = clamp(g + fade * GOLD[1])
                b = clamp(b + fade * GOLD[2])
                pixels[y * width + x] = (r, g, b, a)
            # Bottom edge glow
            if y > height - 4:
                fade = (y - (height - 4)) / 3 * 0.15
                r, g, b, a = pixels[y * width + x]
                r = clamp(r + fade * GOLD[0])
                g = clamp(g + fade * GOLD[1])
                b = clamp(b + fade * GOLD[2])
                pixels[y * width + x] = (r, g, b, a)

    return pixels


if __name__ == "__main__":
    output_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(output_dir, exist_ok=True)

    print("Combyne AI — DMG Background Generator")
    print(f"Output: {output_dir}")

    W, H = 600, 400
    print(f"  Generating {W}x{H} background...")
    pixels = generate_background(W, H)
    png_data = create_png(W, H, pixels)

    out_path = os.path.join(output_dir, "dmg-background.png")
    with open(out_path, 'wb') as f:
        f.write(png_data)
    print(f"  Saved {out_path} ({len(png_data)} bytes)")
