#!/usr/bin/env python3
"""
Combyne AI — App Icon Generator
Generates a 1024x1024 PNG icon with:
  - Deep black (#0B0B0F) background with rounded corners
  - Amber gold (#F5A623) honeycomb/hexagon pattern
  - Bold "C" letter in the center in amber gold
  - Saves as .icns file via iconutil

Usage:
  python3 generate-icon.py [output_dir]

Output:
  output_dir/AppIcon.icns
  output_dir/AppIcon.iconset/  (intermediate iconset)
"""

import struct
import zlib
import math
import os
import sys
import subprocess
import shutil

# ── Brand Colors ─────────────────────────────────────────────────────────────
BG_COLOR = (11, 11, 15)         # #0B0B0F - deep black
GOLD = (245, 166, 35)           # #F5A623 - primary amber gold
GOLD2 = (234, 179, 8)           # #EAB308 - secondary gold
DARK_GOLD = (180, 120, 20)      # Darker gold for depth
HIGHLIGHT = (255, 200, 80)      # Bright highlight gold


def create_png(width, height, pixels):
    """Create a PNG file from RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    header = b'\x89PNG\r\n\x1a\n'
    # Color type 6 = RGBA
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))

    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter: none
        for x in range(width):
            idx = y * width + x
            raw += pixels[idx]

    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')

    return header + ihdr + idat + iend


def lerp(a, b, t):
    """Linear interpolation between a and b."""
    return a + (b - a) * t


def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, int(v)))


def distance(x1, y1, x2, y2):
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


def hex_distance(x, y, cx, cy, size):
    """Distance from point to nearest hexagon edge centered at (cx, cy)."""
    dx = abs(x - cx) / size
    dy = abs(y - cy) / size
    return max(dx * 2 / math.sqrt(3) + dy, dy * 2) - 1.0


def rounded_rect_alpha(x, y, w, h, radius):
    """Returns 0.0-1.0 alpha for a rounded rectangle."""
    # Check if inside the rounded rectangle
    if x < radius:
        if y < radius:
            d = distance(x, y, radius, radius)
            if d > radius:
                return max(0.0, 1.0 - (d - radius))
            return 1.0
        elif y > h - radius:
            d = distance(x, y, radius, h - radius)
            if d > radius:
                return max(0.0, 1.0 - (d - radius))
            return 1.0
    elif x > w - radius:
        if y < radius:
            d = distance(x, y, w - radius, radius)
            if d > radius:
                return max(0.0, 1.0 - (d - radius))
            return 1.0
        elif y > h - radius:
            d = distance(x, y, w - radius, h - radius)
            if d > radius:
                return max(0.0, 1.0 - (d - radius))
            return 1.0

    if 0 <= x <= w and 0 <= y <= h:
        return 1.0
    return 0.0


def is_in_letter_c(x, y, cx, cy, outer_r, inner_r, gap_angle=55):
    """Check if point (x,y) is inside a "C" letter shape."""
    dx = x - cx
    dy = y - cy
    dist = math.sqrt(dx * dx + dy * dy)

    if dist < inner_r or dist > outer_r:
        return 0.0

    # Angle in degrees (0 = right, going counter-clockwise)
    angle = math.degrees(math.atan2(-dy, dx))  # Flip y for screen coords
    if angle < 0:
        angle += 360

    # Gap on the right side (the opening of the C)
    half_gap = gap_angle / 2
    if angle < half_gap or angle > 360 - half_gap:
        return 0.0

    # Anti-aliasing at edges
    aa = 1.0
    edge_outer = outer_r - dist
    edge_inner = dist - inner_r
    if edge_outer < 1.5:
        aa = min(aa, edge_outer / 1.5)
    if edge_inner < 1.5:
        aa = min(aa, edge_inner / 1.5)

    # Anti-alias the gap edges
    if angle < half_gap + 3:
        aa = min(aa, (angle - half_gap) / 3)
    if angle > 360 - half_gap - 3:
        aa = min(aa, (360 - half_gap - angle) / 3)

    return max(0.0, aa)


def generate_icon(size=1024):
    """Generate the Combyne AI app icon at the given size."""
    pixels = []
    center = size / 2
    corner_radius = size * 0.22  # macOS-style rounded corners

    # Hexagon grid parameters
    hex_size = size / 14
    hex_rows = int(size / (hex_size * math.sqrt(3))) + 4
    hex_cols = int(size / (hex_size * 1.5)) + 4

    # Pre-compute hex centers
    hex_centers = []
    for row in range(-2, hex_rows):
        for col in range(-2, hex_cols):
            hx = col * hex_size * 1.75
            hy = row * hex_size * math.sqrt(3) + (hex_size * math.sqrt(3) * 0.5 if col % 2 else 0)
            hex_centers.append((hx, hy))

    # "C" letter parameters
    c_outer_r = size * 0.30
    c_inner_r = size * 0.175
    c_gap_angle = 60

    for y in range(size):
        for x in range(size):
            # Rounded rectangle mask
            alpha = rounded_rect_alpha(x, y, size - 1, size - 1, corner_radius)
            if alpha <= 0:
                pixels.append(bytes([0, 0, 0, 0]))
                continue

            # Base: deep black background
            r, g, b = BG_COLOR

            # Subtle radial gradient: dark center, slightly lighter edges (depth effect)
            dist_from_center = distance(x, y, center, center) / (size * 0.7)
            # Very subtle vignette - darker at edges
            vignette = max(0, 1.0 - dist_from_center * 0.15)

            # Honeycomb pattern
            min_hex_edge = float('inf')
            for hx, hy in hex_centers:
                he = hex_distance(x, y, hx, hy, hex_size)
                if abs(he) < abs(min_hex_edge):
                    min_hex_edge = he

            # Draw hex edges as subtle gold lines
            edge_dist = abs(min_hex_edge * hex_size)
            if edge_dist < 2.0:
                # Intensity falls off with distance from center (honeycomb fades toward edges)
                center_fade = max(0, 1.0 - dist_from_center * 0.6)
                line_intensity = (2.0 - edge_dist) / 2.0 * 0.20 * center_fade
                r = clamp(r + line_intensity * GOLD[0])
                g = clamp(g + line_intensity * GOLD[1])
                b = clamp(b + line_intensity * GOLD[2] * 0.4)

            # Inner subtle glow behind the "C"
            glow_dist = distance(x, y, center, center) / (size * 0.35)
            if glow_dist < 1.0:
                glow = (1.0 - glow_dist) ** 2 * 0.12
                r = clamp(r + glow * GOLD[0])
                g = clamp(g + glow * GOLD[1])
                b = clamp(b + glow * GOLD[2] * 0.3)

            # The "C" letter
            c_alpha = is_in_letter_c(x, y, center, center, c_outer_r, c_inner_r, c_gap_angle)
            if c_alpha > 0:
                # Gold gradient on the C: lighter at top-left, darker at bottom-right
                gradient_t = ((x - center) + (y - center)) / (c_outer_r * 2) * 0.5 + 0.5
                gradient_t = max(0, min(1, gradient_t))

                cr = lerp(HIGHLIGHT[0], DARK_GOLD[0], gradient_t)
                cg = lerp(HIGHLIGHT[1], DARK_GOLD[1], gradient_t)
                cb = lerp(HIGHLIGHT[2], DARK_GOLD[2], gradient_t)

                # Blend with background
                r = clamp(lerp(r, cr, c_alpha))
                g = clamp(lerp(g, cg, c_alpha))
                b = clamp(lerp(b, cb, c_alpha))

                # Subtle inner highlight on the C (bevel effect)
                inner_edge = (distance(x, y, center, center) - c_inner_r) / (c_outer_r - c_inner_r)
                if inner_edge < 0.15:
                    highlight = (0.15 - inner_edge) / 0.15 * 0.3 * c_alpha
                    r = clamp(r + highlight * 40)
                    g = clamp(g + highlight * 30)
                    b = clamp(b + highlight * 10)

            # Outer ring accent (subtle golden ring around the icon border area)
            border_dist = max(
                min(x, size - 1 - x, y, size - 1 - y)
            , 0)
            effective_border = border_dist
            # Account for rounded corners
            if x < corner_radius and y < corner_radius:
                effective_border = min(effective_border, distance(x, y, corner_radius, corner_radius) - (corner_radius - 8))
            elif x > size - corner_radius and y < corner_radius:
                effective_border = min(effective_border, distance(x, y, size - corner_radius, corner_radius) - (corner_radius - 8))
            elif x < corner_radius and y > size - corner_radius:
                effective_border = min(effective_border, distance(x, y, corner_radius, size - corner_radius) - (corner_radius - 8))
            elif x > size - corner_radius and y > size - corner_radius:
                effective_border = min(effective_border, distance(x, y, size - corner_radius, size - corner_radius) - (corner_radius - 8))

            if 3 < effective_border < 8:
                border_intensity = 1.0 - abs(effective_border - 5.5) / 2.5
                border_intensity *= 0.35
                r = clamp(r + border_intensity * GOLD[0])
                g = clamp(g + border_intensity * GOLD[1])
                b = clamp(b + border_intensity * GOLD[2] * 0.4)

            # Apply vignette
            r = clamp(r * vignette)
            g = clamp(g * vignette)
            b = clamp(b * vignette)

            a = clamp(alpha * 255)
            pixels.append(bytes([r, g, b, a]))

    return pixels


def generate_and_save(output_dir):
    """Generate icon at all required sizes and create .icns file."""
    iconset_dir = os.path.join(output_dir, "AppIcon.iconset")
    os.makedirs(iconset_dir, exist_ok=True)

    # macOS iconset requires these sizes
    # Format: (filename, pixel_size)
    icon_sizes = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]

    # Generate the master 1024x1024 icon
    print("  Generating 1024x1024 master icon...")
    master_pixels = generate_icon(1024)
    master_path = os.path.join(iconset_dir, "icon_512x512@2x.png")
    png_data = create_png(1024, 1024, master_pixels)
    with open(master_path, 'wb') as f:
        f.write(png_data)
    print(f"  Saved {master_path} ({len(png_data)} bytes)")

    # Also save a standalone copy for reference
    ref_path = os.path.join(output_dir, "AppIcon_1024.png")
    with open(ref_path, 'wb') as f:
        f.write(png_data)

    # Generate other sizes
    needed_sizes = set()
    for filename, pixel_size in icon_sizes:
        if pixel_size != 1024:
            needed_sizes.add(pixel_size)

    generated = {1024: master_pixels}

    for sz in sorted(needed_sizes):
        print(f"  Generating {sz}x{sz}...")
        pixels = generate_icon(sz)
        generated[sz] = pixels

    # Write all icon files
    for filename, pixel_size in icon_sizes:
        filepath = os.path.join(iconset_dir, filename)
        if not os.path.exists(filepath):
            pixels = generated[pixel_size]
            png_data = create_png(pixel_size, pixel_size, pixels)
            with open(filepath, 'wb') as f:
                f.write(png_data)
            print(f"  Saved {filename} ({pixel_size}x{pixel_size})")

    # Convert iconset to icns using iconutil (macOS only)
    icns_path = os.path.join(output_dir, "AppIcon.icns")

    if sys.platform == "darwin" and shutil.which("iconutil"):
        print("  Converting to .icns with iconutil...")
        try:
            subprocess.run(
                ["iconutil", "-c", "icns", iconset_dir, "-o", icns_path],
                check=True,
                capture_output=True,
                text=True
            )
            print(f"  Created {icns_path}")
        except subprocess.CalledProcessError as e:
            print(f"  WARNING: iconutil failed: {e.stderr}")
            print("  Falling back to sips-based conversion...")
            try_sips_conversion(iconset_dir, icns_path, output_dir)
    else:
        print("  WARNING: iconutil not available (not on macOS?)")
        print(f"  Icon PNG saved to {ref_path}")
        # Create a simple copy as .icns (won't be a real icns but better than nothing)
        shutil.copy2(ref_path, icns_path)

    # Clean up iconset directory (optional, keep for debugging)
    # shutil.rmtree(iconset_dir, ignore_errors=True)

    print(f"\n  Icon generation complete!")
    print(f"  ICNS: {icns_path}")
    print(f"  PNG:  {ref_path}")

    return icns_path


def try_sips_conversion(iconset_dir, icns_path, output_dir):
    """Try using sips as a fallback for icon conversion."""
    try:
        # sips can't make icns directly, but we can use it to verify PNGs
        png_1024 = os.path.join(output_dir, "AppIcon_1024.png")
        if os.path.exists(png_1024):
            # Try iconutil one more time with a fresh iconset
            subprocess.run(
                ["iconutil", "-c", "icns", iconset_dir, "-o", icns_path],
                check=True,
                capture_output=True,
                text=True
            )
    except Exception as e:
        print(f"  Fallback conversion also failed: {e}")
        # Copy the PNG as a last resort
        shutil.copy2(os.path.join(output_dir, "AppIcon_1024.png"), icns_path)


if __name__ == "__main__":
    output_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    print(f"\nCombyne AI — Icon Generator")
    print(f"Output directory: {output_dir}\n")
    generate_and_save(output_dir)
