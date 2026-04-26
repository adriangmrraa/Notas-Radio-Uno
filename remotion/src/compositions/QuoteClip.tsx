/**
 * QuoteClip.tsx — Premium vertical clip for radio/TV conductor and guest quotes.
 *
 * Style: 1080x1920, 30fps, dark (#050505), cyan accents (#00E5FF),
 * SpaceGrotesk/Sora fonts, spring animations, film grain, particles.
 *
 * Timeline (at 30fps):
 *   0–30f   (0–1s):   Flash white + energy lines opening
 *   30–210f (1–7s):   Quote reveal word-by-word with spring animation
 *   210–300f (7–10s): Speaker reveal — photo, name, role
 *   300–360f (10–12s): Branding — program + platform
 *   360–end:          Outro fade
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

// ─── Design tokens (same as FusaLabsAd3) ────────────────────────────────────
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
  gold: "#FFD700",
  goldDim: "rgba(255,215,0,0.15)",
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
              opacity:
                p.opacity + Math.sin(frame * 0.05 + p.phase) * 0.04,
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

// ─── Animated background (radial gradient + subtle glow) ─────────────────────
const AnimatedBg: React.FC<{ frame: number }> = ({ frame }) => {
  const pulse = 0.5 + Math.sin(frame * 0.03) * 0.5;
  const hue = interpolate(frame, [0, 300], [200, 260], {
    extrapolateRight: "extend",
  });
  return (
    <>
      <AbsoluteFill style={{ backgroundColor: C.void }} />
      {/* Radial glow — top center */}
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
            0.04 + pulse * 0.02
          }) 0%, transparent 65%)`,
          zIndex: 1,
        }}
      />
      {/* Radial glow — bottom */}
      <div
        style={{
          position: "absolute",
          bottom: -300,
          left: "50%",
          transform: "translateX(-50%)",
          width: 700,
          height: 700,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(${Math.round(
            hue
          )},0,255,0.05) 0%, transparent 60%)`,
          zIndex: 1,
        }}
      />
    </>
  );
};

// ─── Single word with spring + chromatic aberration ──────────────────────────
const KineticWord: React.FC<{
  word: string;
  frame: number;
  triggerF: number;
  isCyan?: boolean;
}> = ({ word, frame, triggerF, isCyan = false }) => {
  const { fps } = useVideoConfig();
  const rel = frame - triggerF;
  if (rel < 0) return null;

  const pop = spring({
    frame: rel,
    fps,
    config: { damping: 12, mass: 0.7, stiffness: 400 },
  });
  const scaleVal = interpolate(pop, [0, 1], [0.3, 1]);
  const blurX = interpolate(pop, [0, 0.7, 1], [60, 8, 0]);
  // Chromatic aberration only on entry for cyan/keyword words
  const aberr = isCyan && rel < 6 ? (6 - rel) * 1.2 : 0;

  return (
    <span
      style={{
        display: "inline-block",
        transform: `scale(${scaleVal})`,
        filter: `blur(${blurX}px)`,
        position: "relative",
        marginRight: "0.2em",
        transformOrigin: "center center",
      }}
    >
      {aberr > 0 && (
        <span
          style={{
            position: "absolute",
            left: -aberr,
            color: "#FF0055",
            opacity: 0.5,
            mixBlendMode: "screen",
          }}
        >
          {word}
        </span>
      )}
      {aberr > 0 && (
        <span
          style={{
            position: "absolute",
            left: aberr,
            color: C.cyan,
            opacity: 0.55,
            mixBlendMode: "screen",
          }}
        >
          {word}
        </span>
      )}
      <span
        style={{
          color: isCyan ? C.cyan : C.w,
          textShadow: isCyan
            ? `0 0 30px ${C.cyanDim}, 0 0 80px ${C.cyanDim}`
            : `0 0 20px rgba(255,255,255,0.15)`,
        }}
      >
        {word}
      </span>
    </span>
  );
};

// Keywords that get cyan treatment
const QUOTE_KEYWORDS = [
  "no", "sí", "nunca", "siempre", "todo", "nada", "hoy", "ahora",
  "importante", "grave", "urgente", "crítico", "increíble", "terrible",
  "never", "always", "now", "today", "critical", "important",
];
const isKeyword = (w: string) =>
  QUOTE_KEYWORDS.includes(w.toLowerCase().replace(/[.,!?¡¿:;]/g, ""));

// ─── Quote text — word-by-word spring reveal ─────────────────────────────────
const QuoteReveal: React.FC<{
  text: string;
  frame: number;
  startF: number; // frame when first word starts
  wordsPerSecond?: number;
}> = ({ text, frame, startF, wordsPerSecond = 3 }) => {
  const { fps } = useVideoConfig();
  const words = text.split(" ").filter(Boolean);
  const framesPerWord = fps / wordsPerSecond;

  // Determine font size: fewer words = bigger
  const fontSize =
    words.length <= 6
      ? 96
      : words.length <= 10
      ? 80
      : words.length <= 16
      ? 68
      : 56;

  return (
    <div
      style={{
        position: "relative",
        zIndex: 12,
        padding: "0 80px",
        textAlign: "center",
        fontFamily: space,
        fontWeight: 900,
        fontSize,
        lineHeight: 1.15,
        letterSpacing: -1,
      }}
    >
      {words.map((word, i) => {
        const wordTrigger = startF + i * framesPerWord;
        if (frame < wordTrigger) return null;
        return (
          <KineticWord
            key={i}
            word={word}
            frame={frame}
            triggerF={wordTrigger}
            isCyan={isKeyword(word)}
          />
        );
      })}
    </div>
  );
};

// ─── Decorative quote mark ───────────────────────────────────────────────────
const DecorativeQuote: React.FC<{ frame: number; startF: number }> = ({
  frame,
  startF,
}) => {
  const opacity = interpolate(frame, [startF, startF + 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        top: 280,
        left: 60,
        zIndex: 5,
        fontSize: 320,
        fontFamily: space,
        fontWeight: 900,
        color: C.gold,
        opacity: opacity * 0.12,
        lineHeight: 0.8,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      "
    </div>
  );
};

// ─── Speaker block (photo + name + role) ─────────────────────────────────────
const SpeakerReveal: React.FC<{
  frame: number;
  startF: number;
  speakerName: string;
  speakerRole: string;
  speakerPhotoUrl?: string;
}> = ({ frame, startF, speakerName, speakerRole, speakerPhotoUrl }) => {
  const { fps } = useVideoConfig();
  const rel = frame - startF;
  if (rel < 0) return null;

  const photoSpring = spring({
    frame: rel,
    fps,
    config: { damping: 14, mass: 1.2, stiffness: 200 },
  });
  const photoScale = interpolate(photoSpring, [0, 1], [0.5, 1]);
  const photoY = interpolate(photoSpring, [0, 1], [80, 0]);
  const photoOpacity = interpolate(rel, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  const nameRel = Math.max(0, rel - 10);
  const nameSpring = spring({
    frame: nameRel,
    fps,
    config: { damping: 14, mass: 1, stiffness: 220 },
  });
  const nameY = interpolate(nameSpring, [0, 1], [40, 0]);
  const nameOpacity = interpolate(nameRel, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  const roleRel = Math.max(0, rel - 18);
  const roleOpacity = interpolate(roleRel, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        bottom: 280,
        left: 0,
        right: 0,
        zIndex: 14,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
      }}
    >
      {/* Photo circle */}
      <div
        style={{
          width: 200,
          height: 200,
          borderRadius: "50%",
          overflow: "hidden",
          border: `3px solid ${C.cyan}`,
          boxShadow: `0 0 40px ${C.cyanDim}, 0 0 80px ${C.cyanBg}`,
          transform: `translateY(${photoY}px) scale(${photoScale})`,
          opacity: photoOpacity,
          background: C.w08,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {speakerPhotoUrl ? (
          <Img
            src={speakerPhotoUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              fontSize: 80,
              color: C.w40,
              fontFamily: space,
              fontWeight: 900,
            }}
          >
            {speakerName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Name */}
      <div
        style={{
          fontFamily: space,
          fontWeight: 900,
          fontSize: 52,
          color: C.w,
          letterSpacing: -1,
          textAlign: "center",
          transform: `translateY(${nameY}px)`,
          opacity: nameOpacity,
          textShadow: `0 0 20px rgba(255,255,255,0.2)`,
          padding: "0 60px",
        }}
      >
        {speakerName}
      </div>

      {/* Role */}
      {speakerRole && (
        <div
          style={{
            fontFamily: sora,
            fontWeight: 600,
            fontSize: 32,
            color: C.w40,
            letterSpacing: 3,
            textTransform: "uppercase",
            textAlign: "center",
            opacity: roleOpacity,
          }}
        >
          {speakerRole}
        </div>
      )}
    </div>
  );
};

// ─── Branding block ──────────────────────────────────────────────────────────
const BrandingBlock: React.FC<{
  frame: number;
  startF: number;
  programName: string;
  platformName: string;
  logoUrl?: string;
}> = ({ frame, startF, programName, platformName, logoUrl }) => {
  const rel = frame - startF;
  if (rel < 0) return null;

  const opacity = interpolate(rel, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const slideY = interpolate(rel, [0, 20], [30, 0], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        position: "absolute",
        bottom: 100,
        left: 0,
        right: 0,
        zIndex: 15,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        opacity,
        transform: `translateY(${slideY}px)`,
      }}
    >
      {/* Separator line */}
      <div
        style={{
          width: 200,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${C.cyan}, transparent)`,
          boxShadow: `0 0 8px ${C.cyan}`,
          marginBottom: 8,
        }}
      />

      {/* Program name */}
      <div
        style={{
          fontFamily: sora,
          fontWeight: 700,
          fontSize: 28,
          color: C.cyan,
          letterSpacing: 4,
          textTransform: "uppercase",
          textShadow: `0 0 20px ${C.cyanDim}`,
        }}
      >
        {programName}
      </div>

      {/* Platform name */}
      <div
        style={{
          fontFamily: sora,
          fontWeight: 500,
          fontSize: 22,
          color: C.w40,
          letterSpacing: 3,
          textTransform: "uppercase",
        }}
      >
        {platformName}
      </div>
    </div>
  );
};

// ─── Progress bar (cyan, thin, bottom) ───────────────────────────────────────
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
        bottom: 0,
        left: 0,
        width: `${width}%`,
        height: 3,
        background: C.cyan,
        boxShadow: `0 0 10px ${C.cyan}`,
        zIndex: 30,
      }}
    />
  );
};

// ─── Props ───────────────────────────────────────────────────────────────────
export interface QuoteClipProps {
  quoteText: string;
  speakerName: string;
  speakerRole: string;
  speakerPhotoUrl?: string;
  programName: string;
  platformName: string;
  logoUrl?: string;
  durationInSeconds: number;
}

// ─── Main composition ────────────────────────────────────────────────────────
export const QuoteClip: React.FC<QuoteClipProps> = ({
  quoteText,
  speakerName,
  speakerRole,
  speakerPhotoUrl,
  programName,
  platformName,
  logoUrl,
  durationInSeconds,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const totalFrames = durationInSeconds * fps;

  // Timeline anchors (all in frames at 30fps)
  const FLASH_END = 10;         // 0.33s
  const QUOTE_START = 30;       // 1s — quote words begin
  const QUOTE_END = Math.round(totalFrames * 0.65); // ~65% of clip
  const SPEAKER_START = QUOTE_END;
  const BRAND_START = Math.round(totalFrames * 0.82); // ~82% of clip

  // Opening flash (white → black)
  const openFlash = interpolate(frame, [0, FLASH_END], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Quote section fade-out as speaker appears
  const quoteSectionOpacity =
    frame >= SPEAKER_START
      ? interpolate(frame, [SPEAKER_START, SPEAKER_START + 20], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  // Words per second — scale to fit quote in the available time
  const words = quoteText.split(" ").filter(Boolean);
  const quoteFrames = QUOTE_END - QUOTE_START;
  const framesPerWord = Math.max(4, Math.floor(quoteFrames / words.length));
  const wordsPerSecond = fps / framesPerWord;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* ── L0: Background ── */}
      <AnimatedBg frame={frame} />

      {/* ── L1: Particles ── */}
      <Particles frame={frame} />

      {/* ── L2: Energy lines at scene transitions ── */}
      <ELine frame={frame} trigger={FLASH_END} top="40%" />
      <ELine frame={frame} trigger={FLASH_END + 8} top="60%" />
      <ELine frame={frame} trigger={SPEAKER_START} top="45%" />
      <ELine frame={frame} trigger={BRAND_START} top="50%" />

      {/* ── L3: Shockwaves ── */}
      <Shockwave frame={frame} trigger={FLASH_END} />
      <Shockwave frame={frame} trigger={SPEAKER_START} />

      {/* ── L4: Decorative large quote mark (fades in with quote) ── */}
      {frame >= QUOTE_START && (
        <div style={{ opacity: quoteSectionOpacity }}>
          <DecorativeQuote frame={frame} startF={QUOTE_START} />
        </div>
      )}

      {/* ── L5: Quote text — vertical center ── */}
      {frame >= QUOTE_START && frame < QUOTE_END + 30 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            zIndex: 12,
            opacity: quoteSectionOpacity,
          }}
        >
          <QuoteReveal
            text={quoteText}
            frame={frame}
            startF={QUOTE_START}
            wordsPerSecond={wordsPerSecond}
          />
        </AbsoluteFill>
      )}

      {/* ── L6: Speaker reveal ── */}
      <SpeakerReveal
        frame={frame}
        startF={SPEAKER_START}
        speakerName={speakerName}
        speakerRole={speakerRole}
        speakerPhotoUrl={speakerPhotoUrl}
      />

      {/* ── L7: Branding block ── */}
      <BrandingBlock
        frame={frame}
        startF={BRAND_START}
        programName={programName}
        platformName={platformName}
        logoUrl={logoUrl}
      />

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
