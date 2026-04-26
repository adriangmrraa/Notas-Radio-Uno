/**
 * NewsClip.tsx — Premium vertical clip for news highlights.
 *
 * Style: 1080x1920, 30fps, dark (#050505), cyan accents (#00E5FF),
 * SpaceGrotesk/Sora fonts, spring animations, film grain, particles,
 * contextual background image with dolly-in, typewriter excerpt.
 *
 * Timeline (at 30fps):
 *   0–10f   (0–0.33s): Flash white
 *   0–60f   (0–2s):    HOOK text HUGE, word-by-word spring animation
 *   60–240f (2–8s):    Title clip-path reveal + excerpt typewriter
 *   240–300f (8–10s):  Branding + shockwave radial
 *   Ticker: always scrolling at bottom
 */

import React, { useMemo } from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  spring,
  Easing,
  Img,
} from "remotion";
import { loadFont as loadSpace } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSora } from "@remotion/google-fonts/Sora";

const { fontFamily: space } = loadSpace();
const { fontFamily: sora } = loadSora();

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  void: "#050505",
  w: "#FFFFFF",
  w80: "rgba(255,255,255,0.80)",
  w60: "rgba(255,255,255,0.60)",
  w40: "rgba(255,255,255,0.40)",
  w20: "rgba(255,255,255,0.20)",
  w15: "rgba(255,255,255,0.15)",
  w08: "rgba(255,255,255,0.08)",
  w04: "rgba(255,255,255,0.04)",
  cyan: "#00E5FF",
  cyanDim: "rgba(0,229,255,0.25)",
  cyanBg: "rgba(0,229,255,0.06)",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ramp = (f: number, r: [number, number]) =>
  interpolate(f, r, [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const expOut = (f: number, from: number, to: number, r: [number, number]) =>
  interpolate(f, r, [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.exp),
  });

// ─── Grain ───────────────────────────────────────────────────────────────────
const Grain: React.FC<{ frame: number }> = ({ frame }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      zIndex: 22,
      pointerEvents: "none",
      opacity: 0.03,
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)'/%3E%3C/svg%3E")`,
      backgroundPosition: `${(frame * 17) % 200}px ${(frame * 37) % 200}px`,
    }}
  />
);

// ─── Particles ───────────────────────────────────────────────────────────────
const Particles: React.FC<{ frame: number }> = ({ frame }) => {
  const pts = useMemo(
    () =>
      Array.from({ length: 45 }, (_, i) => ({
        x: (Math.sin(i * 47.3) * 0.5 + 0.5) * 1080,
        baseY: (Math.sin(i * 83.1) * 0.5 + 0.5) * 1920,
        speed: 0.35 + (Math.sin(i * 31.7) * 0.5 + 0.5) * 0.9,
        size: 1 + (Math.sin(i * 61.2) * 0.5 + 0.5) * 2.5,
        phase: (Math.sin(i * 17.9) * 0.5 + 0.5) * Math.PI * 2,
        opacity: 0.06 + (Math.sin(i * 29.4) * 0.5 + 0.5) * 0.1,
      })),
    []
  );
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 4,
        pointerEvents: "none",
      }}
    >
      {pts.map((p, i) => {
        const y = (p.baseY - frame * p.speed * 1.4) % 1920;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x + Math.sin(frame * 0.025 + p.phase) * 18,
              top: y < 0 ? y + 1920 : y,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: C.cyan,
              opacity: p.opacity + Math.sin(frame * 0.05 + p.phase) * 0.04,
              filter: p.size > 2 ? "blur(1px)" : "none",
            }}
          />
        );
      })}
    </div>
  );
};

// ─── Energy line ─────────────────────────────────────────────────────────────
const ELine: React.FC<{ frame: number; trigger: number; top?: string }> = ({
  frame,
  trigger,
  top = "50%",
}) => {
  const r = frame - trigger;
  if (r < 0 || r > 22) return null;
  return (
    <div
      style={{
        position: "absolute",
        zIndex: 8,
        top,
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: `${expOut(frame, 0, 100, [trigger, trigger + 14])}%`,
        height: 2,
        background: `linear-gradient(90deg, transparent, ${C.cyan}, transparent)`,
        opacity: interpolate(r, [0, 6, 22], [0, 0.9, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        boxShadow: `0 0 14px ${C.cyan}`,
        pointerEvents: "none",
      }}
    />
  );
};

// ─── Shockwave ───────────────────────────────────────────────────────────────
const Shockwave: React.FC<{ frame: number; trigger: number }> = ({
  frame,
  trigger,
}) => {
  const r = frame - trigger;
  if (r < 0 || r > 28) return null;
  return (
    <div
      style={{
        position: "absolute",
        zIndex: 6,
        pointerEvents: "none",
        top: "50%",
        left: "50%",
        width: 360,
        height: 360,
        transform: `translate(-50%, -50%) scale(${expOut(
          frame,
          0.05,
          4,
          [trigger, trigger + 28]
        )})`,
        borderRadius: "50%",
        border: `2px solid ${C.cyan}`,
        opacity: interpolate(r, [0, 4, 28], [0, 0.7, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        boxShadow: `0 0 30px ${C.cyanDim}`,
      }}
    />
  );
};

// ─── Background: contextual image with dolly-in OR animated gradient ─────────
const NewsBackground: React.FC<{
  frame: number;
  backgroundImageUrl?: string;
}> = ({ frame, backgroundImageUrl }) => {
  if (backgroundImageUrl) {
    // Dolly in: slow zoom from 1.0 to 1.12 over entire clip
    const scale = interpolate(frame, [0, 300], [1.0, 1.12], {
      extrapolateRight: "clamp",
    });
    return (
      <>
        <AbsoluteFill style={{ backgroundColor: C.void }} />
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <Img
            src={backgroundImageUrl}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${scale})`,
              filter: "brightness(0.35) contrast(1.2) grayscale(0.2)",
            }}
          />
        </AbsoluteFill>
        {/* Vignette overlay */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at center, transparent 20%, rgba(5,5,5,0.85) 80%)`,
            zIndex: 2,
          }}
        />
      </>
    );
  }

  // Fallback: animated dark gradient
  const shift = interpolate(frame, [0, 300], [0, 30], {
    extrapolateRight: "clamp",
  });
  const pulse = 0.5 + Math.sin(frame * 0.03) * 0.5;
  return (
    <>
      <AbsoluteFill style={{ backgroundColor: C.void }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(${135 + shift}deg, #050505 0%, #0a0a15 40%, #060612 70%, #050505 100%)`,
          zIndex: 1,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: -200,
          left: "50%",
          transform: "translateX(-50%)",
          width: 900,
          height: 900,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(0,229,255,${
            0.05 + pulse * 0.025
          }) 0%, transparent 65%)`,
          zIndex: 2,
        }}
      />
    </>
  );
};

// ─── Hook text — HUGE, word-by-word spring, mix-blend-mode difference ────────
const HookWord: React.FC<{
  word: string;
  frame: number;
  triggerF: number;
}> = ({ word, frame, triggerF }) => {
  const { fps } = useVideoConfig();
  const rel = frame - triggerF;
  if (rel < 0) return null;

  const pop = spring({
    frame: rel,
    fps,
    config: { damping: 10, mass: 0.6, stiffness: 450 },
  });
  const scaleVal = interpolate(pop, [0, 1], [0.2, 1]);
  const blurVal = interpolate(pop, [0, 0.6, 1], [80, 15, 0]);
  const aberr = rel < 5 ? (5 - rel) * 2 : 0;

  return (
    <div
      style={{
        position: "relative",
        display: "block",
        transform: `scale(${scaleVal})`,
        filter: `blur(${blurVal}px)`,
        lineHeight: 0.85,
      }}
    >
      {aberr > 0 && (
        <span
          style={{
            position: "absolute",
            left: -aberr * 2,
            color: "#FF0055",
            opacity: 0.6,
            mixBlendMode: "screen",
            fontFamily: space,
            fontWeight: 900,
            textTransform: "uppercase",
          }}
        >
          {word}
        </span>
      )}
      {aberr > 0 && (
        <span
          style={{
            position: "absolute",
            left: aberr * 2,
            color: C.cyan,
            opacity: 0.6,
            mixBlendMode: "screen",
            fontFamily: space,
            fontWeight: 900,
            textTransform: "uppercase",
          }}
        >
          {word}
        </span>
      )}
      <span
        style={{
          fontFamily: space,
          fontWeight: 900,
          textTransform: "uppercase",
          color: C.w,
          mixBlendMode: "difference",
          textShadow: `0 0 40px rgba(255,255,255,0.3)`,
        }}
      >
        {word}
      </span>
    </div>
  );
};

// ─── Hook section — each word stacks vertically, enormous ────────────────────
const HookReveal: React.FC<{
  hookText: string;
  frame: number;
  startF: number;
  endF: number;
}> = ({ hookText, frame, startF, endF }) => {
  const { fps } = useVideoConfig();
  const words = hookText.split(" ").filter(Boolean);
  const framesPerWord = Math.max(6, Math.floor((endF - startF) / words.length));

  // Determine font size based on longest word
  const maxWordLen = Math.max(...words.map((w) => w.length));
  const fontSize = maxWordLen > 10 ? 160 : maxWordLen > 7 ? 190 : 220;

  const sectionOpacity =
    frame > endF
      ? interpolate(frame, [endF, endF + 15], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        zIndex: 12,
        opacity: sectionOpacity,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          fontSize,
          letterSpacing: -4,
        }}
      >
        {words.map((word, i) => {
          const triggerF = startF + i * framesPerWord;
          if (frame < triggerF) return null;
          return (
            <HookWord key={i} word={word} frame={frame} triggerF={triggerF} />
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ─── Title with clip-path reveal ──────────────────────────────────────────────
const TitleReveal: React.FC<{
  title: string;
  frame: number;
  startF: number;
}> = ({ title, frame, startF }) => {
  const { fps } = useVideoConfig();
  const rel = frame - startF;
  if (rel < 0) return null;

  const s = spring({
    frame: rel,
    fps,
    config: { damping: 14, mass: 1, stiffness: 200 },
  });
  const clipPct = interpolate(s, [0, 1], [100, 0]);
  const slideY = interpolate(s, [0, 1], [60, 0]);

  const fontSize = title.length > 60 ? 44 : title.length > 40 ? 52 : 62;

  return (
    <div
      style={{
        clipPath: `inset(0 0 ${clipPct}% 0)`,
        transform: `translateY(${slideY}px)`,
        fontFamily: space,
        fontWeight: 900,
        fontSize,
        color: C.w,
        textAlign: "center",
        lineHeight: 1.15,
        letterSpacing: -1,
        padding: "0 60px",
        textShadow: `0 0 30px rgba(255,255,255,0.15)`,
      }}
    >
      {title}
    </div>
  );
};

// ─── Excerpt with typewriter effect ──────────────────────────────────────────
const ExcerptTypewriter: React.FC<{
  excerpt: string;
  frame: number;
  startF: number;
}> = ({ excerpt, frame, startF }) => {
  const rel = frame - startF;
  if (rel < 0) return null;

  const charsToShow = Math.floor(
    interpolate(rel, [0, excerpt.length * 1.5], [0, excerpt.length], {
      extrapolateRight: "clamp",
    })
  );
  const displayText = excerpt.slice(0, charsToShow);

  const opacity = interpolate(rel, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        fontFamily: sora,
        fontWeight: 500,
        fontSize: 34,
        color: C.w60,
        textAlign: "center",
        lineHeight: 1.5,
        letterSpacing: 0.5,
        padding: "0 80px",
        opacity,
      }}
    >
      {displayText}
      {/* Cursor blink */}
      {charsToShow < excerpt.length && (
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: "1em",
            background: C.cyan,
            marginLeft: 4,
            verticalAlign: "middle",
            opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0,
          }}
        />
      )}
    </div>
  );
};

// ─── Branding (program + platform + radial shockwave) ────────────────────────
const BrandingSection: React.FC<{
  frame: number;
  startF: number;
  programName: string;
  platformName: string;
  logoUrl?: string;
}> = ({ frame, startF, programName, platformName, logoUrl }) => {
  const { fps } = useVideoConfig();
  const rel = frame - startF;
  if (rel < 0) return null;

  const s = spring({
    frame: rel,
    fps,
    config: { damping: 12, mass: 1, stiffness: 220 },
  });
  const scaleVal = interpolate(s, [0, 1], [0.7, 1]);
  const opacity = interpolate(rel, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Radial shockwave glow
  const radialOpacity =
    rel < 30
      ? interpolate(rel, [0, 5, 30], [0, 0.4, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 120,
        zIndex: 15,
        opacity,
      }}
    >
      {/* Radial glow shockwave */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${scaleVal})`,
          width: 600,
          height: 600,
          background: `radial-gradient(circle, ${C.cyanDim} 0%, transparent 60%)`,
          opacity: radialOpacity,
          zIndex: -1,
        }}
      />

      <div
        style={{
          transform: `scale(${scaleVal})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
        }}
      >
        {/* Separator */}
        <div
          style={{
            width: 180,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${C.cyan}, transparent)`,
            boxShadow: `0 0 10px ${C.cyan}`,
          }}
        />
        {/* Program name */}
        <div
          style={{
            fontFamily: sora,
            fontWeight: 700,
            fontSize: 30,
            color: C.cyan,
            letterSpacing: 5,
            textTransform: "uppercase",
            textShadow: `0 0 25px ${C.cyanDim}`,
          }}
        >
          {programName}
        </div>
        {/* Platform */}
        <div
          style={{
            fontFamily: sora,
            fontWeight: 500,
            fontSize: 22,
            color: C.w40,
            letterSpacing: 4,
            textTransform: "uppercase",
          }}
        >
          {platformName}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Bottom ticker ────────────────────────────────────────────────────────────
const Ticker: React.FC<{ frame: number; programName: string }> = ({
  frame,
  programName,
}) => {
  const TICK = `${programName.toUpperCase()} · ÚLTIMAS NOTICIAS · ${programName.toUpperCase()} · BREAKING · `;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        height: 52,
        overflow: "hidden",
        borderTop: `1px solid ${C.w15}`,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          whiteSpace: "nowrap",
          transform: `translateX(${-(frame * 4) % (TICK.length * 18)}px)`,
          fontSize: 20,
          fontFamily: sora,
          fontWeight: 600,
          color: C.w40,
          letterSpacing: 3,
          textTransform: "uppercase",
        }}
      >
        {TICK.repeat(12)}
      </div>
    </div>
  );
};

// ─── Progress bar ─────────────────────────────────────────────────────────────
const CyanProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const width = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 52, // just above the ticker
        left: 0,
        width: `${width}%`,
        height: 3,
        background: C.cyan,
        boxShadow: `0 0 10px ${C.cyan}`,
        zIndex: 21,
      }}
    />
  );
};

// ─── Props ───────────────────────────────────────────────────────────────────
export interface NewsClipProps {
  title: string;
  excerpt: string;
  hookText: string;
  programName: string;
  platformName: string;
  logoUrl?: string;
  backgroundImageUrl?: string;
  durationInSeconds: number;
}

// ─── Main composition ────────────────────────────────────────────────────────
export const NewsClip: React.FC<NewsClipProps> = ({
  title,
  excerpt,
  hookText,
  programName,
  platformName,
  logoUrl,
  backgroundImageUrl,
  durationInSeconds,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const totalFrames = durationInSeconds * fps;

  // Timeline anchors (at 30fps)
  const FLASH_END = 10;
  const HOOK_START = 0;
  const HOOK_END = Math.round(fps * 2); // 0–2s
  const CONTENT_START = HOOK_END;       // 2s
  const CONTENT_TITLE_START = HOOK_END + 8;
  const EXCERPT_START = HOOK_END + 30;
  const BRAND_START = Math.round(totalFrames * 0.80); // ~80% of clip

  // Opening flash
  const openFlash = interpolate(frame, [0, FLASH_END], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Content section opacity (fades in at CONTENT_START, fades out at BRAND_START)
  const contentOpacity =
    frame < CONTENT_START
      ? 0
      : frame >= BRAND_START
      ? interpolate(frame, [BRAND_START, BRAND_START + 20], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : interpolate(frame, [CONTENT_START, CONTENT_START + 20], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* ── L0: Background ── */}
      <NewsBackground frame={frame} backgroundImageUrl={backgroundImageUrl} />

      {/* ── L1: Particles ── */}
      <Particles frame={frame} />

      {/* ── L2: Energy lines ── */}
      <ELine frame={frame} trigger={FLASH_END} top="38%" />
      <ELine frame={frame} trigger={FLASH_END + 8} top="62%" />
      <ELine frame={frame} trigger={HOOK_END} top="42%" />
      <ELine frame={frame} trigger={BRAND_START} top="50%" />

      {/* ── L3: Shockwaves ── */}
      <Shockwave frame={frame} trigger={FLASH_END} />
      <Shockwave frame={frame} trigger={HOOK_END} />
      <Shockwave frame={frame} trigger={BRAND_START} />

      {/* ── L4: HOOK text (0–2s) — HUGE, word-by-word ── */}
      <HookReveal
        hookText={hookText}
        frame={frame}
        startF={HOOK_START}
        endF={HOOK_END}
      />

      {/* ── L5: Content section (2s–brand) ── */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          zIndex: 13,
          opacity: contentOpacity,
          flexDirection: "column",
          gap: 40,
          padding: "200px 0",
        }}
      >
        <TitleReveal
          title={title}
          frame={frame}
          startF={CONTENT_TITLE_START}
        />
        <ExcerptTypewriter
          excerpt={excerpt}
          frame={frame}
          startF={EXCERPT_START}
        />
      </AbsoluteFill>

      {/* ── L6: Branding ── */}
      <BrandingSection
        frame={frame}
        startF={BRAND_START}
        programName={programName}
        platformName={platformName}
        logoUrl={logoUrl}
      />

      {/* ── L7: Ticker (always) ── */}
      <Ticker frame={frame} programName={programName} />

      {/* ── L8: Progress bar ── */}
      <CyanProgressBar />

      {/* ── L9: Film grain ── */}
      <Grain frame={frame} />

      {/* ── L10: Opening flash overlay ── */}
      {openFlash > 0 && (
        <AbsoluteFill
          style={{ backgroundColor: C.w, opacity: openFlash, zIndex: 100 }}
        />
      )}
    </AbsoluteFill>
  );
};
