import { interpolate, useCurrentFrame, useVideoConfig, spring } from "remotion";
import React from "react";

type AnimatedTextProps = {
  text: string;
  startFrame?: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  animation?: "fadeIn" | "slideUp" | "scaleIn" | "typewriter";
  style?: React.CSSProperties;
};

export const AnimatedText: React.FC<AnimatedTextProps> = ({
  text,
  startFrame = 0,
  fontSize = 48,
  color = "#ffffff",
  fontFamily = "Arial, sans-serif",
  fontWeight = "bold",
  animation = "fadeIn",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const relativeFrame = frame - startFrame;

  if (relativeFrame < 0) return null;

  let opacity = 1;
  let transform = "none";
  let displayText = text;

  switch (animation) {
    case "fadeIn":
      opacity = interpolate(relativeFrame, [0, 20], [0, 1], {
        extrapolateRight: "clamp",
      });
      break;
    case "slideUp":
      opacity = interpolate(relativeFrame, [0, 20], [0, 1], {
        extrapolateRight: "clamp",
      });
      const y = interpolate(relativeFrame, [0, 20], [50, 0], {
        extrapolateRight: "clamp",
      });
      transform = `translateY(${y}px)`;
      break;
    case "scaleIn":
      const scale = spring({
        frame: relativeFrame,
        fps,
        config: { damping: 12 },
      });
      opacity = interpolate(relativeFrame, [0, 10], [0, 1], {
        extrapolateRight: "clamp",
      });
      transform = `scale(${scale})`;
      break;
    case "typewriter":
      const charsToShow = Math.floor(
        interpolate(relativeFrame, [0, text.length * 2], [0, text.length], {
          extrapolateRight: "clamp",
        })
      );
      displayText = text.slice(0, charsToShow);
      break;
  }

  return (
    <div
      style={{
        fontSize,
        color,
        fontFamily,
        fontWeight,
        opacity,
        transform,
        textAlign: "center",
        ...style,
      }}
    >
      {displayText}
    </div>
  );
};
