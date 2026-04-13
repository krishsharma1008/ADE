---
name: video
description: >
  Generate product demo videos, explainer animations, and motion graphics from
  prompts using Remotion (React-based video framework). Use when asked to create
  a video, product demo, screen recording animation, marketing clip, or any
  animated visual output. Outputs MP4 or GIF via CLI render.
user-invocable: true
argument-hint: "<description of the video you want>"
---

# Video Generation Skill (Remotion)

You create videos programmatically using **Remotion** — React components that render frame-by-frame into MP4. Every video is code. You can generate any visual from a prompt: product demos, feature walkthroughs, animated slides, logo reveals, data visualizations.

---

## Workflow

```
Prompt → Plan scenes → Scaffold project → Write components → Preview → Render MP4
```

---

## Step 1: Understand the Video Request

Extract from the prompt:
- **Type**: product demo / feature walkthrough / explainer / marketing clip / data viz
- **Duration**: default 30s (900 frames @ 30fps) unless specified
- **Resolution**: 1920×1080 (landscape) or 1080×1920 (portrait/mobile) or 1080×1080 (square)
- **Brand**: colors, fonts, logo if provided
- **Scenes**: break the request into timed scenes (see Scene Planning below)

---

## Step 2: Scaffold the Project

```bash
# In the target directory
npx create-video@latest

# Choose template based on use case:
# - "Hello World"      → simple product demos, animations
# - "Blank"            → full custom control
# - "Next.js"          → if embedding in a web app

# Start the studio (live preview)
cd <project-name>
npm run dev
# Opens http://localhost:3000
```

---

## Step 3: Core API — The Building Blocks

### Frame & Config
```tsx
import { useCurrentFrame, useVideoConfig } from 'remotion';

const frame = useCurrentFrame();           // Current frame number (0-indexed)
const { fps, durationInFrames, width, height } = useVideoConfig();

const seconds = frame / fps;              // Convert to seconds
```

### Container
```tsx
import { AbsoluteFill } from 'remotion';

// Full-screen container with flex centering
<AbsoluteFill style={{ backgroundColor: '#0f0f0f', justifyContent: 'center', alignItems: 'center' }}>
  {/* your content */}
</AbsoluteFill>
```

### Animate Values — interpolate()
```tsx
import { interpolate } from 'remotion';

// Fade in over first 30 frames
const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });

// Slide in from bottom
const translateY = interpolate(frame, [0, 30], [50, 0], { extrapolateRight: 'clamp' });

// Multi-keyframe animation
const scale = interpolate(frame, [0, 15, 30], [0.8, 1.05, 1.0], { extrapolateRight: 'clamp' });
```

### Spring Animations (bouncy, natural feel)
```tsx
import { spring, useVideoConfig } from 'remotion';

const { fps } = useVideoConfig();
const progress = spring({ frame, fps, config: { damping: 80, stiffness: 200 } });
// progress goes 0→1 with natural physics
const scale = interpolate(progress, [0, 1], [0.8, 1]);
```

### Sequence (time-shift scenes)
```tsx
import { Sequence } from 'remotion';

// Shows at frame 30, lasts 60 frames
<Sequence from={30} durationInFrames={60} name="Hero Text">
  <HeroText />
</Sequence>

// Shows at frame 90 until end
<Sequence from={90} name="CTA">
  <CallToAction />
</Sequence>
```

### Series (scenes one after another)
```tsx
import { Series } from 'remotion';

<Series>
  <Series.Sequence durationInFrames={90}>  {/* 3s */}
    <IntroScene />
  </Series.Sequence>
  <Series.Sequence durationInFrames={150}> {/* 5s */}
    <FeatureScene />
  </Series.Sequence>
  <Series.Sequence durationInFrames={60}>  {/* 2s */}
    <OutroScene />
  </Series.Sequence>
</Series>
```

### Media
```tsx
import { Img, Audio, Video, staticFile } from 'remotion';

<Img src={staticFile('logo.png')} style={{ width: 200 }} />
<Audio src={staticFile('bg-music.mp3')} volume={0.3} />
<Video src={staticFile('screen-recording.mp4')} />
```

---

## Step 4: Project Structure

```
my-video/
├── src/
│   ├── Root.tsx              # Registers all compositions
│   ├── compositions/
│   │   ├── ProductDemo.tsx   # Main composition
│   │   └── scenes/
│   │       ├── Intro.tsx
│   │       ├── Feature1.tsx
│   │       ├── Feature2.tsx
│   │       └── Outro.tsx
│   └── components/
│       ├── Title.tsx         # Reusable animated text
│       ├── Card.tsx          # Feature card component
│       └── Logo.tsx          # Brand logo
├── public/
│   ├── logo.png
│   └── bg-music.mp3
└── remotion.config.ts
```

---

## Step 5: Composition Registration (Root.tsx)

```tsx
import { Composition } from 'remotion';
import { ProductDemo } from './compositions/ProductDemo';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ProductDemo"
        component={ProductDemo}
        durationInFrames={900}   // 30s @ 30fps
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
```

---

## Step 6: Render to MP4

```bash
# Render specific composition
npx remotion render ProductDemo out/product-demo.mp4

# With options
npx remotion render ProductDemo out/demo.mp4 \
  --codec=h264 \
  --fps=30 \
  --quality=80

# Render as GIF
npx remotion render ProductDemo out/demo.gif

# Render still (single frame) for thumbnail
npx remotion still ProductDemo --frame=0 out/thumbnail.png
```

---

## Scene Planning Templates

### Product Demo (30s)
```
Frame 0–60   (2s)  → Logo/brand reveal
Frame 60–180 (4s)  → Problem statement / hook
Frame 180–420 (8s) → Feature 1 walkthrough
Frame 420–660 (8s) → Feature 2 walkthrough
Frame 660–810 (5s) → Results / social proof
Frame 810–900 (3s) → CTA + logo
```

### Feature Walkthrough (15s)
```
Frame 0–45  (1.5s) → Title card
Frame 45–180 (4.5s) → Step 1 with annotation
Frame 180–315 (4.5s) → Step 2 with annotation
Frame 315–420 (3.5s) → Result + CTA
Frame 420–450 (1s)  → Outro
```

### Explainer (60s)
```
Frame 0–90   (3s)  → Hook / question
Frame 90–360 (9s)  → Context / problem
Frame 360–900 (18s) → Solution walkthrough (3 sections × 6s)
Frame 900–1500 (20s) → Demo
Frame 1500–1710 (7s) → Benefits summary
Frame 1710–1800 (3s) → CTA
```

---

## Reusable Animation Components

### AnimatedText
```tsx
import { interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';

export const AnimatedText: React.FC<{ text: string; delay?: number }> = ({ text, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame - delay, [0, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const translateY = interpolate(frame - delay, [0, 20], [20, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{ opacity, transform: `translateY(${translateY}px)`, color: 'white', fontSize: 64, fontWeight: 700 }}>
      {text}
    </div>
  );
};
```

### FadeIn wrapper
```tsx
export const FadeIn: React.FC<{ delay?: number; children: React.ReactNode }> = ({ delay = 0, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <div style={{ opacity }}>{children}</div>;
};
```

### Typewriter effect
```tsx
export const Typewriter: React.FC<{ text: string; startFrame: number }> = ({ text, startFrame }) => {
  const frame = useCurrentFrame();
  const charsToShow = Math.floor(interpolate(frame - startFrame, [0, text.length * 3], [0, text.length], { extrapolateRight: 'clamp' }));
  return <span>{text.slice(0, charsToShow)}</span>;
};
```

### Progress bar
```tsx
export const ProgressBar: React.FC<{ progress: number; color?: string }> = ({ progress, color = '#6366f1' }) => (
  <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3 }}>
    <div style={{ width: `${progress * 100}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.1s' }} />
  </div>
);
```

---

## Design Tokens for Product Videos

```tsx
export const THEME = {
  bg: '#0B0B0F',
  bgCard: '#1a1a24',
  primary: '#6366f1',   // indigo
  accent: '#f59e0b',    // amber
  text: '#ffffff',
  textMuted: '#9ca3af',
  font: 'Inter, sans-serif',
  radius: 16,
};

// Standard sizes at 1920×1080
export const SIZES = {
  titleFontSize: 80,
  subtitleFontSize: 40,
  bodyFontSize: 28,
  captionFontSize: 22,
  padding: 120,         // page margin
};
```

---

## Common Mistakes to Avoid

- **No hooks outside components** — `useCurrentFrame` must be inside a React component
- **Always clamp interpolations** — add `extrapolateLeft: 'clamp', extrapolateRight: 'clamp'` or values go out of range
- **Static assets in `/public`** — reference with `staticFile('filename.png')`, not raw paths
- **Register every composition** — add to `Root.tsx` or it won't appear in studio
- **Frame math** — always think in frames: 1s = 30 frames (at 30fps), 2s = 60 frames

---

## Full Reference

For detailed API docs, rendering options, AWS Lambda rendering, and advanced patterns, read: `skills/video/references/`

- `api-reference.md` — full interpolate, spring, Sequence, Series, Audio, Video API
- `templates.md` — ready-to-use scene templates for common video types
- `render-options.md` — all CLI flags, codecs, quality settings
