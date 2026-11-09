/**
 * LiveClipOverlay.tsx — Overlay de marca TRANSPARENTE para clips del crudo (T-31, D6)
 *
 * Composición 1080x1920 SIN fondo (alpha): se renderiza a WebM VP8 con
 * alpha (yuva420p) y se superpone al footage real en la misma pasada
 * ffmpeg del clipCutter (crop→scale→subs→overlay).
 *
 * Capas:
 *   - Top-left: logo del tenant (data URL — branding real del canal).
 *   - Top-right: watermark platformName (semitransparente, siempre).
 *   - Lower-third: nombre+rol de la persona atribuida — entra con spring
 *     al inicio y permanece `lowerThirdSec` segundos (primera aparición).
 *   - Bottom: progress bar fina del clip (accent del tenant).
 *
 * Props (via --props del clipCutter):
 *   logoDataUrl?      — data:image/...;base64 del logo tenant (logoData bytea)
 *   personName?       — nombre resuelto por atribución (lower-third)
 *   personRole?       — rol (conductor/invitado/...)
 *   programName       — nombre del programa/canal
 *   platformName      — marca del tenant (watermark)
 *   accentColor?      — color de acento (default cyan PeriodistApp)
 *   durationInSeconds — duración del clip (progress + lower-third timing)
 *   lowerThirdSec?    — segundos visible del lower-third (default 6)
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadSpace } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSora } from "@remotion/google-fonts/Sora";

// google-fonts loadFont: (a) puede fallar en bundle-eval (internals
// faltantes en algunas versiones/entornos) → fallback a stacks del sistema;
// (b) por default trae TODOS los pesos+subsets (timeout de delayRender en
// redes lentas) → se limita a latin y los pesos usados. El overlay nunca
// debe morir por una fuente — el render ffmpeg depende de él.
const safeFont = (loader: () => { fontFamily: string }, fallback: string): string => {
  try {
    return loader().fontFamily;
  } catch {
    return fallback;
  }
};
const space = safeFont(() => loadSpace("normal", { weights: ["500", "700"], subsets: ["latin"] }), '"Space Grotesk", Arial, sans-serif');
const sora = safeFont(() => loadSora("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }), '"Sora", Arial, sans-serif');

export interface LiveClipOverlayProps {
  logoDataUrl?: string;
  personName?: string;
  personRole?: string;
  programName: string;
  platformName: string;
  accentColor?: string;
  durationInSeconds: number;
  lowerThirdSec?: number;
}

export const LiveClipOverlay: React.FC<LiveClipOverlayProps> = ({
  logoDataUrl,
  personName,
  personRole,
  programName,
  platformName,
  accentColor = "#00E5FF",
  durationInSeconds,
  lowerThirdSec = 6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Lower-third timing: entra a los ~0.5s, dura lowerThirdSec, sale ──
  const ltIn = Math.round(fps * 0.5);
  const ltOut = Math.round(fps * lowerThirdSec);
  const ltInSpring = spring({
    frame: Math.max(0, frame - ltIn),
    fps,
    config: { damping: 16, mass: 0.8, stiffness: 180 },
  });
  const ltSlide = interpolate(ltInSpring, [0, 1], [-120, 0]);
  const ltOpacity =
    frame < ltIn
      ? 0
      : frame <= ltOut
        ? 1
        : interpolate(frame, [ltOut, ltOut + fps * 0.6], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

  // ── Progress: barra fina que avanza con el clip ──
  const totalFrames = Math.max(1, Math.round(durationInSeconds * fps));
  const progress = Math.min(1, frame / totalFrames);

  // Logo entra con fade suave en los primeros frames
  const brandOpacity = interpolate(frame, [0, fps * 0.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      {/* ── Logo tenant (top-left) ── */}
      {logoDataUrl && (
        <div
          style={{
            position: "absolute",
            top: 56,
            left: 56,
            opacity: brandOpacity,
          }}
        >
          <Img
            src={logoDataUrl}
            style={{
              maxWidth: 220,
              maxHeight: 110,
              objectFit: "contain",
              filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.65))",
            }}
          />
        </div>
      )}

      {/* ── Watermark platformName (top-right, sutil) ── */}
      <div
        style={{
          position: "absolute",
          top: 64,
          right: 56,
          opacity: brandOpacity * 0.55,
          fontFamily: sora,
          fontWeight: 700,
          fontSize: 26,
          letterSpacing: 3,
          textTransform: "uppercase",
          color: "#FFFFFF",
          textShadow: "0 1px 6px rgba(0,0,0,0.6)",
          textAlign: "right",
        }}
      >
        {platformName}
        <div
          style={{
            marginTop: 4,
            fontSize: 18,
            fontWeight: 500,
            letterSpacing: 2,
            color: accentColor,
          }}
        >
          {programName}
        </div>
      </div>

      {/* ── Lower-third persona (primera aparición) ── */}
      {personName && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 220,
            opacity: ltOpacity,
            transform: `translateX(${ltSlide}px)`,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 18,
              marginLeft: 56,
              padding: "18px 34px",
              background: "rgba(0,0,0,0.72)",
              borderLeft: `8px solid ${accentColor}`,
              backdropFilter: "blur(4px)",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: space,
                  fontWeight: 900,
                  fontSize: 54,
                  lineHeight: 1,
                  color: "#FFFFFF",
                  textTransform: "uppercase",
                  letterSpacing: -1,
                  textShadow: "0 2px 10px rgba(0,0,0,0.5)",
                }}
              >
                {personName}
              </div>
              {personRole && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: sora,
                    fontWeight: 600,
                    fontSize: 26,
                    color: accentColor,
                    textTransform: "uppercase",
                    letterSpacing: 3,
                  }}
                >
                  {personRole}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Progress bar bottom ── */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          background: "rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: accentColor,
            boxShadow: `0 0 12px ${accentColor}`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export default LiveClipOverlay;
