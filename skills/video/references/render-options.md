# Remotion Render Options & CLI Reference

## Basic Render

```bash
# Render a composition to MP4
npx remotion render <CompositionId> <output-path>

# Examples
npx remotion render ProductDemo out/product-demo.mp4
npx remotion render LogoReveal out/logo.mp4
npx remotion render SlideDeck out/slides.mp4
```

## Codec Options

```bash
# H.264 (best compatibility — use for web, Slack, email)
npx remotion render ProductDemo out/demo.mp4 --codec=h264

# H.265 (smaller file, less compatible)
npx remotion render ProductDemo out/demo.mp4 --codec=h265

# VP8/VP9 (for web, transparent background support)
npx remotion render ProductDemo out/demo.webm --codec=vp8

# ProRes (for video editing software — large file)
npx remotion render ProductDemo out/demo.mov --codec=prores

# GIF (for Slack, documentation, short loops)
npx remotion render ProductDemo out/demo.gif

# Audio only
npx remotion render ProductDemo out/audio.mp3 --codec=mp3
```

## Resolution & Frame Rate

```bash
# Custom FPS (override composition fps)
npx remotion render ProductDemo out/demo.mp4 --fps=60

# Scale output (0.5 = half resolution, 2 = double)
npx remotion render ProductDemo out/demo.mp4 --scale=0.5
```

## Quality

```bash
# Quality 0-100 (default 80), affects file size
npx remotion render ProductDemo out/demo.mp4 --quality=90

# CRF (constant rate factor) for h264 — lower = better quality
npx remotion render ProductDemo out/demo.mp4 --crf=18
```

## Rendering Range

```bash
# Render only frames 0-90 (first 3 seconds at 30fps)
npx remotion render ProductDemo out/demo.mp4 --frames=0-90

# Render a single still frame (for thumbnails)
npx remotion still ProductDemo --frame=0 out/thumbnail.png
npx remotion still ProductDemo --frame=45 out/thumbnail.png
```

## Parallelism & Performance

```bash
# Use more CPU cores for faster render
npx remotion render ProductDemo out/demo.mp4 --concurrency=8

# Use max available cores
npx remotion render ProductDemo out/demo.mp4 --concurrency=100%
```

## Props Override (render with different data)

```bash
# Pass props as JSON to override defaultProps
npx remotion render ProductDemo out/demo.mp4 \
  --props='{"productName":"Combyne","tagline":"AI Company OS"}'
```

## Standard Resolutions

| Format | Width | Height | Use Case |
|--------|-------|--------|----------|
| 1080p Landscape | 1920 | 1080 | YouTube, presentations |
| 4K Landscape | 3840 | 2160 | High-res demos |
| Square | 1080 | 1080 | LinkedIn, Instagram |
| Portrait | 1080 | 1920 | TikTok, Instagram Reels, mobile |
| Twitter/X | 1280 | 720 | Social sharing |
| Thumbnail | 1280 | 720 | Preview images |

## Development Preview

```bash
# Start studio with hot reload
npm run dev
# Opens http://localhost:3000

# Preview specific composition
npx remotion studio --props='{"productName":"Test"}'
```

## Common Render Recipes

```bash
# Quick web-ready MP4
npx remotion render ProductDemo out/demo.mp4 --codec=h264 --quality=80

# High quality for download
npx remotion render ProductDemo out/demo-hq.mp4 --codec=h264 --crf=18

# Small file for email/Slack
npx remotion render ProductDemo out/demo-small.mp4 --codec=h264 --quality=60 --scale=0.75

# Animated GIF (keep short < 10s for reasonable size)
npx remotion render LogoReveal out/logo.gif --frames=0-90

# Thumbnail
npx remotion still ProductDemo --frame=30 out/thumbnail.png
```
