import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import React from "react";

type BackgroundProps = {
  type?: "solid" | "gradient" | "radial" | "animated-gradient";
  colors?: string[];
  angle?: number;
};

export const Background: React.FC<BackgroundProps> = ({
  type = "solid",
  colors = ["#0f0f0f"],
  angle = 135,
}) => {
  const frame = useCurrentFrame();

  let background: string;

  switch (type) {
    case "gradient":
      background = `linear-gradient(${angle}deg, ${colors.join(", ")})`;
      break;
    case "radial":
      background = `radial-gradient(circle, ${colors.join(", ")})`;
      break;
    case "animated-gradient": {
      const shift = interpolate(frame, [0, 150], [0, 360], {
        extrapolateRight: "extend",
      });
      background = `linear-gradient(${angle + shift}deg, ${colors.join(", ")})`;
      break;
    }
    default:
      background = colors[0];
  }

  return (
    <AbsoluteFill
      style={{
        background,
      }}
    />
  );
};
