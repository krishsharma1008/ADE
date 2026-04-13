# Remotion Video Templates

Ready-to-use scene templates for common product video types.

---

## Template 1: SaaS Product Demo

Full 30-second product demo. Replace `{ProductName}`, `{Feature1}`, etc. with real content.

```tsx
// src/Root.tsx
import { Composition } from 'remotion';
import { ProductDemo } from './compositions/ProductDemo';

export const RemotionRoot = () => (
  <Composition
    id="ProductDemo"
    component={ProductDemo}
    durationInFrames={900}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{
      productName: 'Combyne',
      tagline: 'Your AI Company OS',
      features: [
        { title: 'AI Agents', desc: 'Autonomous agents that do the work' },
        { title: 'Issue Tracking', desc: 'From ticket to merged PR automatically' },
        { title: 'Integrations', desc: 'GitHub, Jira, SonarQube and more' },
      ],
      primaryColor: '#6366f1',
      ctaText: 'Start Free Trial',
    }}
  />
);

// src/compositions/ProductDemo.tsx
import { AbsoluteFill, Series, useVideoConfig } from 'remotion';
import { IntroScene } from './scenes/IntroScene';
import { FeatureScene } from './scenes/FeatureScene';
import { OutroScene } from './scenes/OutroScene';

export const ProductDemo: React.FC<{
  productName: string;
  tagline: string;
  features: Array<{ title: string; desc: string }>;
  primaryColor: string;
  ctaText: string;
}> = ({ productName, tagline, features, primaryColor, ctaText }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#0B0B0F', fontFamily: 'Inter, sans-serif' }}>
      <Series>
        {/* Intro: 3s */}
        <Series.Sequence durationInFrames={90}>
          <IntroScene productName={productName} tagline={tagline} primaryColor={primaryColor} />
        </Series.Sequence>

        {/* Features: 8s each */}
        {features.map((f, i) => (
          <Series.Sequence key={i} durationInFrames={240}>
            <FeatureScene {...f} index={i} primaryColor={primaryColor} />
          </Series.Sequence>
        ))}

        {/* Outro: 5s */}
        <Series.Sequence durationInFrames={150}>
          <OutroScene productName={productName} ctaText={ctaText} primaryColor={primaryColor} />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};

// src/compositions/scenes/IntroScene.tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const IntroScene: React.FC<{ productName: string; tagline: string; primaryColor: string }> = ({
  productName, tagline, primaryColor
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 60, stiffness: 200 } });
  const textOpacity = interpolate(frame, [20, 45], [0, 1], { extrapolateRight: 'clamp' });
  const taglineOpacity = interpolate(frame, [40, 65], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 24, flexDirection: 'column' }}>
      {/* Logo / Product mark */}
      <div style={{
        transform: `scale(${logoScale})`,
        width: 100, height: 100,
        background: primaryColor,
        borderRadius: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 48, fontWeight: 800, color: 'white',
      }}>
        {productName[0]}
      </div>

      {/* Product name */}
      <div style={{ opacity: textOpacity, fontSize: 80, fontWeight: 800, color: 'white', letterSpacing: -2 }}>
        {productName}
      </div>

      {/* Tagline */}
      <div style={{ opacity: taglineOpacity, fontSize: 32, color: '#9ca3af', fontWeight: 400 }}>
        {tagline}
      </div>
    </AbsoluteFill>
  );
};

// src/compositions/scenes/FeatureScene.tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const FeatureScene: React.FC<{
  title: string; desc: string; index: number; primaryColor: string;
}> = ({ title, desc, index, primaryColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideIn = spring({ frame, fps, config: { damping: 80, stiffness: 200 } });
  const x = interpolate(slideIn, [0, 1], [-80, 0]);
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-start', padding: 120 }}>
      {/* Feature number */}
      <div style={{ opacity, transform: `translateX(${x}px)` }}>
        <div style={{ fontSize: 20, color: primaryColor, fontWeight: 700, marginBottom: 16, letterSpacing: 4, textTransform: 'uppercase' }}>
          Feature {index + 1}
        </div>
        <div style={{ fontSize: 72, fontWeight: 800, color: 'white', marginBottom: 24, lineHeight: 1.1 }}>
          {title}
        </div>
        <div style={{ fontSize: 36, color: '#9ca3af', maxWidth: 700, lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// src/compositions/scenes/OutroScene.tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const OutroScene: React.FC<{
  productName: string; ctaText: string; primaryColor: string;
}> = ({ productName, ctaText, primaryColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 60, stiffness: 200 } });
  const ctaOpacity = interpolate(frame, [30, 60], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 32 }}>
      <div style={{ transform: `scale(${scale})`, fontSize: 64, fontWeight: 800, color: 'white' }}>
        {productName}
      </div>

      <div style={{
        opacity: ctaOpacity,
        background: primaryColor,
        color: 'white',
        padding: '20px 48px',
        borderRadius: 12,
        fontSize: 28,
        fontWeight: 700,
      }}>
        {ctaText}
      </div>
    </AbsoluteFill>
  );
};
```

---

## Template 2: Animated Slide Deck (Keynote-style)

For presenting concepts, pitches, or walkthroughs slide-by-slide.

```tsx
// Each slide is a Series.Sequence, 5s each
import { Series, AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

const Slide: React.FC<{ title: string; bullets: string[]; color: string }> = ({ title, bullets, color }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#0B0B0F', padding: 120, opacity }}>
      <div style={{ borderLeft: `6px solid ${color}`, paddingLeft: 40 }}>
        <div style={{ fontSize: 64, fontWeight: 800, color: 'white', marginBottom: 40 }}>{title}</div>
        {bullets.map((b, i) => {
          const bulletOpacity = interpolate(frame, [i * 8 + 10, i * 8 + 30], [0, 1], { extrapolateRight: 'clamp' });
          return (
            <div key={i} style={{ opacity: bulletOpacity, fontSize: 32, color: '#d1d5db', marginBottom: 20, display: 'flex', gap: 16 }}>
              <span style={{ color }}>→</span> {b}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const SlideDeck = () => (
  <AbsoluteFill style={{ background: '#0B0B0F' }}>
    <Series>
      <Series.Sequence durationInFrames={150}>
        <Slide title="The Problem" bullets={['Manual processes are slow', 'Context switching kills focus', 'No single source of truth']} color="#f59e0b" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={150}>
        <Slide title="Our Solution" bullets={['AI agents do the work', 'Everything in one place', 'Full audit trail']} color="#6366f1" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={150}>
        <Slide title="Results" bullets={['10× faster delivery', '80% less context switching', 'Full code governance']} color="#10b981" />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
```

---

## Template 3: Metric / Number Reveal

```tsx
import { interpolate, useCurrentFrame, spring, useVideoConfig, AbsoluteFill } from 'remotion';

const CountUp: React.FC<{ from: number; to: number; suffix?: string; label: string; color: string }> = ({
  from, to, suffix = '', label, color
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 50, stiffness: 100 } });
  const value = Math.round(interpolate(progress, [0, 1], [from, to]));

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 120, fontWeight: 900, color, lineHeight: 1 }}>{value}{suffix}</div>
      <div style={{ fontSize: 28, color: '#9ca3af', marginTop: 12 }}>{label}</div>
    </div>
  );
};

export const MetricReveal = () => (
  <AbsoluteFill style={{ background: '#0B0B0F', justifyContent: 'center', alignItems: 'center', gap: 100, flexDirection: 'row' }}>
    <CountUp from={0} to={10} suffix="×" label="Faster Delivery" color="#6366f1" />
    <CountUp from={0} to={80} suffix="%" label="Less Overhead" color="#f59e0b" />
    <CountUp from={0} to={100} suffix="%" label="Audit Coverage" color="#10b981" />
  </AbsoluteFill>
);
```

---

## Template 4: Screen Recording Overlay

For product demos with a real screen recording as background + animated callouts.

```tsx
import { AbsoluteFill, Video, staticFile, Sequence, interpolate, useCurrentFrame } from 'remotion';

const Callout: React.FC<{ text: string; x: number; y: number; delay: number }> = ({ text, x, y, delay }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scale = interpolate(frame - delay, [0, 15], [0.8, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{
      position: 'absolute', left: x, top: y, opacity, transform: `scale(${scale})`,
      background: '#6366f1', color: 'white', padding: '10px 20px',
      borderRadius: 8, fontSize: 22, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {text}
    </div>
  );
};

export const ScreenDemo = () => (
  <AbsoluteFill>
    {/* Background screen recording */}
    <Video src={staticFile('screen-recording.mp4')} style={{ width: '100%', height: '100%' }} />

    {/* Callout annotations appear at specific times */}
    <Sequence from={30}>  <Callout text="Click here to create a task" x={400} y={200} delay={0} /> </Sequence>
    <Sequence from={90}>  <Callout text="Agent picks it up automatically" x={600} y={350} delay={0} /> </Sequence>
    <Sequence from={180}> <Callout text="PR raised within minutes" x={800} y={150} delay={0} /> </Sequence>
  </AbsoluteFill>
);
```

---

## Template 5: Logo / Brand Reveal

```tsx
import { AbsoluteFill, spring, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export const LogoReveal: React.FC<{ name: string; color: string; tagline?: string }> = ({ name, color, tagline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoSpring = spring({ frame, fps, config: { damping: 50, stiffness: 150 } });
  const nameOpacity = interpolate(frame, [20, 50], [0, 1], { extrapolateRight: 'clamp' });
  const taglineOpacity = interpolate(frame, [50, 80], [0, 1], { extrapolateRight: 'clamp' });
  const lineWidth = interpolate(frame, [40, 80], [0, 200], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 20, background: '#0B0B0F' }}>
      <div style={{ transform: `scale(${logoSpring})`, width: 120, height: 120, background: color, borderRadius: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 60, fontWeight: 900, color: 'white' }}>
        {name[0]}
      </div>
      <div style={{ opacity: nameOpacity, fontSize: 72, fontWeight: 800, color: 'white', letterSpacing: -2 }}>
        {name}
      </div>
      <div style={{ width: lineWidth, height: 2, background: color }} />
      {tagline && <div style={{ opacity: taglineOpacity, fontSize: 28, color: '#9ca3af' }}>{tagline}</div>}
    </AbsoluteFill>
  );
};
```
