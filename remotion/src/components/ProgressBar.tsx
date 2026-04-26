import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import React from "react";

type ProgressBarProps = {
  color?: string;
  height?: number;
  position?: "top" | "bottom";
};

export const ProgressBar: React.FC<ProgressBarProps> = ({
  color = "#6366f1",
  height = 4,
  position = "bottom",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const width = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          [position]: 0,
          left: 0,
          width: `${width}%`,
          height,
          backgroundColor: color,
        }}
      />
    </AbsoluteFill>
  );
};
