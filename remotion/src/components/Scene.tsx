import { AbsoluteFill, Sequence } from "remotion";
import React from "react";

type SceneProps = {
  from: number;
  durationInFrames?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

export const Scene: React.FC<SceneProps> = ({
  from,
  durationInFrames,
  children,
  style = {},
}) => {
  return (
    <Sequence from={from} durationInFrames={durationInFrames}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          ...style,
        }}
      >
        {children}
      </AbsoluteFill>
    </Sequence>
  );
};
