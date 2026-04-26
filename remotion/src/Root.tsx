import React from "react";
import { Composition } from "remotion";
import { QuoteClip } from "./compositions/QuoteClip";
import { NewsClip } from "./compositions/NewsClip";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="QuoteClip"
        component={QuoteClip}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          quoteText: "Esta es una cita de ejemplo del conductor del programa",
          speakerName: "Juan Pérez",
          speakerRole: "Conductor",
          programName: "Noticias en Vivo",
          platformName: "PeriodistApp",
          durationInSeconds: 10,
        }}
      />
      <Composition
        id="NewsClip"
        component={NewsClip}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          title: "Título de la noticia destacada del día",
          excerpt: "Extracto clave de la noticia con el contexto más relevante...",
          hookText: "ESTO CAMBIA TODO",
          programName: "Noticias en Vivo",
          platformName: "PeriodistApp",
          durationInSeconds: 10,
        }}
      />
    </>
  );
};
