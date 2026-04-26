import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  staticFile,
} from "remotion";
import React from "react";

type ImageSlideProps = {
  src: string;
  isStaticFile?: boolean;
  animation?: "zoomIn" | "panLeft" | "panRight" | "fadeIn" | "kenBurns";
  fit?: "cover" | "contain";
};

export const ImageSlide: React.FC<ImageSlideProps> = ({
  src,
  isStaticFile = true,
  animation = "zoomIn",
  fit = "cover",
}) => {
  const frame = useCurrentFrame();
  const imgSrc = isStaticFile ? staticFile(src) : src;

  let transform = "none";
  let opacity = 1;

  switch (animation) {
    case "zoomIn": {
      const scale = interpolate(frame, [0, 90], [1, 1.15], {
        extrapolateRight: "clamp",
      });
      transform = `scale(${scale})`;
      break;
    }
    case "panLeft": {
      const x = interpolate(frame, [0, 90], [5, -5], {
        extrapolateRight: "clamp",
      });
      transform = `translateX(${x}%) scale(1.1)`;
      break;
    }
    case "panRight": {
      const x = interpolate(frame, [0, 90], [-5, 5], {
        extrapolateRight: "clamp",
      });
      transform = `translateX(${x}%) scale(1.1)`;
      break;
    }
    case "kenBurns": {
      const scale = interpolate(frame, [0, 120], [1, 1.2], {
        extrapolateRight: "clamp",
      });
      const x = interpolate(frame, [0, 120], [0, -3], {
        extrapolateRight: "clamp",
      });
      transform = `scale(${scale}) translateX(${x}%)`;
      break;
    }
    case "fadeIn":
      opacity = interpolate(frame, [0, 20], [0, 1], {
        extrapolateRight: "clamp",
      });
      break;
  }

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={imgSrc}
        style={{
          width: "100%",
          height: "100%",
          objectFit: fit,
          transform,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};
